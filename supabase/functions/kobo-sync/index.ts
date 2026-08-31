// Kobo → HPF ingestion service — Supabase Edge Function.
//
// The only piece of this pipeline that ever talks to Kobo or holds a Kobo
// credential. KOBO_API_TOKEN lives only here, as a Deno secret — never in
// any file shipped to the browser (dashboards.js has zero Kobo references;
// grep it and see). The dashboard's monitoring page only ever reads the
// Postgres tables this function writes — it never calls Kobo directly,
// and never could, since it has no token to call it with.
//
// auth: 'secret' — this function only runs for a caller holding the
// project's own secret key (never a user JWT, never the publishable key
// the browser ships). That's what actually stops "connect Kobo directly
// to dashboard components": even if someone found this function's URL,
// they cannot invoke it without a credential the browser never has. See
// ../../KOBO-INTEGRATION.md for exactly what to configure and how.
//
// Pipeline, all in one process (see KOBO-INTEGRATION.md for why one
// well-structured function is the honest scope here, not five deployed
// microservices for a few hundred submissions):
//
//   fetch (Kobo API, paginated, resumed from a stored high-water-mark)
//     → ingest (raw payload stored FIRST, unconditionally — the "never
//       silently discard" guarantee: even a submission that fails every
//       later stage still has a permanent kobo_raw_payloads row)
//     → validate (structural/envelope checks — no per-form field
//       knowledge assumed; see validateSubmission)
//     → transform (split Kobo's system fields from the answers)
//     → deduplicate (exact content-hash match against this form's other
//       submissions — a genuine second Kobo _id with identical answers,
//       not the same _id fetched twice, which the raw-payload unique
//       constraint already makes a no-op before this point)
//     → PostgreSQL (kobo_submissions, one row per Kobo submission, never
//       overwritten — every stage above only ever advances or annotates
//       its status)
//
// Every run — success or failure, per form — is logged to
// kobo_sync_runs, which is what the monitoring page's "last successful/
// failed synchronization" reads.

import { withSupabase } from "npm:@supabase/server";

const KOBO_BASE_URL = (Deno.env.get("KOBO_BASE_URL") || "https://kf.kobotoolbox.org").replace(/\/+$/, "");
const KOBO_API_TOKEN = Deno.env.get("KOBO_API_TOKEN");
const KOBO_FORM_IDS = (Deno.env.get("KOBO_FORM_IDS") || "").split(",").map((s) => s.trim()).filter(Boolean);

const PAGE_LIMIT = 1000;
// Per form, per run — not a hard ceiling on history. A backlog bigger
// than this just takes more scheduled runs to fully catch up; each
// submission is written and committed individually (never one giant
// transaction), so a run that hits this cap, or times out, or crashes
// mid-page loses nothing already written and simply resumes from the
// stored high-water-mark next time it's invoked.
const MAX_PAGES_PER_FORM = 5;

export default {
  fetch: withSupabase({ auth: "secret" }, async (_req: Request, ctx: any) => {
    const admin = ctx.supabaseAdmin;

    if (!KOBO_API_TOKEN) {
      await recordConfigFailure(admin, "KOBO_API_TOKEN is not set — see KOBO-INTEGRATION.md.");
      return json({ error: "KOBO_API_TOKEN is not configured." }, 500);
    }
    if (!KOBO_FORM_IDS.length) {
      await recordConfigFailure(admin, "KOBO_FORM_IDS is not set — nothing to sync. See KOBO-INTEGRATION.md.");
      return json({ error: "KOBO_FORM_IDS is not configured." }, 500);
    }

    const results = [];
    for (const formId of KOBO_FORM_IDS) {
      results.push(await syncForm(admin, formId));
    }
    return json({ results });
  }),
};

/* ------------------------------------------------------------ per-form sync */

async function syncForm(admin: any, formId: string) {
  const { data: run } = await admin
    .from("kobo_sync_runs")
    .insert({ form_id: formId, status: "running" })
    .select("id")
    .single();
  const runId = run?.id;

  const counts = { fetched: 0, processed: 0, duplicate: 0, review: 0, rejected: 0 };
  const problems: string[] = [];

  try {
    // Resume from the latest submitted_at this form already has on file.
    // Null (first-ever sync for this form) means fetch full history —
    // "never silently discard" applies to a first sync too, not just
    // ongoing deltas.
    const { data: cursorRow } = await admin
      .from("kobo_submissions")
      .select("submitted_at")
      .eq("form_id", formId)
      .order("submitted_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const cursor: string | null = cursorRow?.submitted_at || null;

    let start = 0;
    for (let page = 0; page < MAX_PAGES_PER_FORM; page++) {
      const data = await fetchKoboPage(formId, cursor, start);
      const rows: any[] = data.results || [];
      if (!rows.length) break;

      for (const raw of rows) {
        counts.fetched++;
        const outcome = await ingestOne(admin, formId, raw);
        switch (outcome.outcome) {
          case "ingested":
            if (outcome.processingStatus === "PROCESSED") counts.processed++;
            else if (outcome.processingStatus === "DUPLICATE") counts.duplicate++;
            else if (outcome.processingStatus === "REQUIRES_REVIEW") counts.review++;
            else if (outcome.processingStatus === "REJECTED") counts.rejected++;
            break;
          case "already_known":
            // Re-polled the same Kobo submission id — already fully
            // recorded from an earlier run. Not new, not a failure, not
            // a business-level duplicate (see the header comment).
            break;
          default:
            // raw_insert_failed / submission_insert_failed — the one
            // outcome this function must never let vanish quietly.
            problems.push(`${outcome.koboId ?? "unknown id"}: ${outcome.error}`);
        }
      }

      if (!data.next) break;
      start += PAGE_LIMIT;
    }

    await admin
      .from("kobo_sync_runs")
      .update({
        status: problems.length ? "failed" : "success",
        finished_at: new Date().toISOString(),
        fetched_count: counts.fetched,
        processed_count: counts.processed,
        duplicate_count: counts.duplicate,
        review_count: counts.review,
        rejected_count: counts.rejected,
        error_detail: problems.length ? problems.slice(0, 20).join("\n").slice(0, 4000) : null,
      })
      .eq("id", runId);

    return { formId, ...counts, problems: problems.length };
  } catch (err) {
    // The Kobo fetch itself failed (network, auth, malformed response) —
    // whatever was ingested before the failure is already safely
    // committed; this just marks the run itself as failed so the
    // monitoring page's "last failed synchronization" is honest about it.
    const message = err instanceof Error ? err.message : String(err);
    await admin
      .from("kobo_sync_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        fetched_count: counts.fetched,
        processed_count: counts.processed,
        duplicate_count: counts.duplicate,
        review_count: counts.review,
        rejected_count: counts.rejected,
        error_detail: message.slice(0, 4000),
      })
      .eq("id", runId);
    return { formId, error: message };
  }
}

async function recordConfigFailure(admin: any, message: string) {
  await admin.from("kobo_sync_runs").insert({
    status: "failed",
    finished_at: new Date().toISOString(),
    error_detail: message,
  });
}

/* ------------------------------------------------------------ Kobo API */

async function fetchKoboPage(formId: string, cursor: string | null, start: number) {
  const query = cursor ? `&query=${encodeURIComponent(JSON.stringify({ _submission_time: { $gt: cursor } }))}` : "";
  const url = `${KOBO_BASE_URL}/api/v2/assets/${encodeURIComponent(formId)}/data.json?format=json&limit=${PAGE_LIMIT}&start=${start}${query}`;
  const res = await fetch(url, { headers: { Authorization: `Token ${KOBO_API_TOKEN}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Kobo API ${res.status} for form ${formId}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/* ------------------------------------------------------------ ingest one submission */

type IngestOutcome =
  | { outcome: "ingested"; processingStatus: string }
  | { outcome: "already_known" }
  | { outcome: "raw_insert_failed" | "submission_insert_failed"; koboId: string; error: string };

async function ingestOne(admin: any, formId: string, raw: Record<string, unknown>): Promise<IngestOutcome> {
  const koboId = String(raw._id ?? raw._uuid ?? "");
  const submittedAt = raw._submission_time ? new Date(raw._submission_time as string).toISOString() : null;

  // Stage 1: store the raw payload FIRST, unconditionally. This is the
  // actual "never silently discard" guarantee — everything after this
  // line only ever adds annotation on top of a fact that is already
  // permanently on disk.
  const { data: rawRow, error: rawErr } = await admin
    .from("kobo_raw_payloads")
    .insert({ form_id: formId, kobo_submission_id: koboId, payload: raw })
    .select("id")
    .maybeSingle();

  if (rawErr) {
    if (rawErr.code === "23505") return { outcome: "already_known" }; // unique_violation
    return { outcome: "raw_insert_failed", koboId, error: rawErr.message };
  }
  const rawPayloadId = rawRow.id;

  // Stage 2: validate — structural/envelope checks only. No per-form
  // field validation, since that needs a real Kobo form schema this
  // pipeline doesn't have yet (see KOBO-INTEGRATION.md).
  const { validationStatus, errors: validationErrors, initialStatus } = validateSubmission(raw, koboId, submittedAt);

  // Stage 3: transform — split Kobo's own system/meta fields from the
  // actual answers, so dedup hashing and any future per-form mapping
  // work against just the answers, not volatile envelope fields.
  const transformed = transformSubmission(raw);
  const contentHash = await computeContentHash(formId, transformed);

  // Stage 4: deduplicate — a genuinely different Kobo submission id with
  // identical answers for this form (an enumerator's accidental re-submit,
  // not a re-poll of the same id — that was already handled above).
  let processingStatus = initialStatus;
  let duplicateOfId: string | null = null;
  if (processingStatus !== "REJECTED") {
    const { data: dupes } = await admin
      .from("kobo_submissions")
      .select("id")
      .eq("form_id", formId)
      .eq("content_hash", contentHash)
      .order("received_at", { ascending: true })
      .limit(1);
    if (dupes && dupes.length) {
      processingStatus = "DUPLICATE";
      duplicateOfId = dupes[0].id;
    } else {
      processingStatus = validationStatus === "passed" ? "PROCESSED" : "REQUIRES_REVIEW";
    }
  }

  const { error: insErr } = await admin.from("kobo_submissions").insert({
    kobo_submission_id: koboId,
    form_id: formId,
    submitted_at: submittedAt,
    raw_payload_id: rawPayloadId,
    validation_status: validationStatus,
    validation_errors: validationErrors,
    transformed_data: transformed,
    content_hash: contentHash,
    processing_status: processingStatus,
    duplicate_of_id: duplicateOfId,
    processed_at: processingStatus === "PROCESSED" ? new Date().toISOString() : null,
  });

  if (insErr) {
    // The raw payload is already permanently stored (rawPayloadId above)
    // even though this row failed — nothing was discarded, only the
    // structured/processed view of it is missing, and that's visible in
    // the sync run's error_detail rather than silently absent.
    return { outcome: "submission_insert_failed", koboId, error: insErr.message };
  }

  return { outcome: "ingested", processingStatus };
}

// Baseline validation every Kobo submission must clear regardless of
// which form it's from — the envelope, not the answers. A missing id
// means the row can't even be tracked, which is the one case treated as
// REJECTED outright; every other gap (unparseable date, no answers at
// all) is REQUIRES_REVIEW, since the data is still real and worth a
// human look, not something to write off.
function validateSubmission(raw: Record<string, unknown>, koboId: string, submittedAt: string | null) {
  const errors: string[] = [];
  if (!koboId) errors.push("Missing Kobo submission id (_id/_uuid).");
  if (!submittedAt) errors.push("Missing or unparseable _submission_time.");
  const answerKeys = Object.keys(raw).filter((k) => !isMetaField(k));
  if (!answerKeys.length) errors.push("Submission has no answer fields.");

  if (!koboId) return { validationStatus: "failed" as const, errors, initialStatus: "REJECTED" as const };
  if (errors.length) return { validationStatus: "failed" as const, errors, initialStatus: "REQUIRES_REVIEW" as const };
  return { validationStatus: "passed" as const, errors: [] as string[], initialStatus: "VALIDATED" as const };
}

function isMetaField(key: string): boolean {
  return key.startsWith("_") || key === "formhub/uuid" || key === "meta/instanceID";
}

// Generic on purpose: this pipeline doesn't know any specific Kobo form's
// question schema, so "transform" here means "separate Kobo's own system
// fields from the actual answers" — not mapping into a domain table like
// field_reports. Doing that for a specific form is a natural follow-up
// once real form/question ids are known (see KOBO-INTEGRATION.md), the
// same "schema now, wiring later" shape as everything else deferred in
// this project's schema.
function transformSubmission(raw: Record<string, unknown>) {
  const meta: Record<string, unknown> = {};
  const answers: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    (isMetaField(key) ? meta : answers)[key] = value;
  }
  return { meta, answers };
}

// SHA-256 over the form id + a canonical (sorted-key) JSON encoding of
// just the answers — never the Kobo system fields, which differ on every
// submission by definition and would defeat content-based dedup entirely.
// This is an EXACT-match dedup: it catches a genuine accidental re-submit
// with identical answers, not a near-duplicate with one corrected field —
// an honest, conservative scope given no per-form field knowledge exists
// to judge which differences matter.
async function computeContentHash(formId: string, transformed: { answers: Record<string, unknown> }): Promise<string> {
  const canonical = `${formId}::${canonicalize(transformed.answers)}`;
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
