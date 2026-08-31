# Kobo → HPF data pipeline

A real ingestion pipeline from KoboToolbox into this project's own
Postgres, and a read-only monitoring page in the admin dashboard that
shows what it's actually done. The code is complete and deployed; it
just has nothing to sync yet because it doesn't have your Kobo account's
details, which this environment cannot obtain or hold on its own (same
reason as [`COMMUNITY-RESOURCES.md`](COMMUNITY-RESOURCES.md)'s API key —
this is credential-shaped, and the checklist below is dashboard/CLI
steps only you can do).

## Architecture

```
Kobo API
  → kobo-sync (Edge Function, the ingestion service)
  → kobo_raw_payloads   (raw submissions, immutable, written first)
  → validation           )
  → transformation        )  all inside kobo-sync, per submission
  → deduplication         )
  → kobo_submissions     (PostgreSQL — the processed record)
  → HPF Portal            (dashboard reads this, read-only)
```

**Kobo credentials exist in exactly one place**: `KOBO_API_TOKEN`, a Deno
secret on the `kobo-sync` Edge Function. `dashboards.js` has zero Kobo
references — grep it and see. The dashboard's monitoring page only ever
reads `kobo_submissions`/`kobo_sync_runs`/`kobo_raw_payloads` through the
normal Supabase client, exactly like every other panel in this app; it
never calls Kobo, and structurally couldn't — it holds no token to call
it with. That is what actually satisfies "do not connect Kobo directly to
dashboard components," not a comment saying not to.

**`kobo-sync` itself only runs for a caller holding this project's own
secret key** (`auth: 'secret'` — see [`@supabase/server`'s
docs](https://github.com/supabase/server)), never a user JWT and never the
publishable key the browser ships. Even someone who found the function's
URL cannot invoke it without a credential the browser never has.

## Checklist

- [x] **Schema** — `kobo_raw_payloads`, `kobo_submissions` (reshaped from
  the bare sink patch-13 left "for a future integration"), `kobo_sync_runs`.
  Applied live. See [`patch-29-kobo-pipeline.sql`](patch-29-kobo-pipeline.sql).
- [x] **Ingestion service** — [`functions/kobo-sync/index.ts`](functions/kobo-sync/index.ts).
  Deployed live (`ACTIVE`, verified). Currently returns a config error and
  logs a failed sync run if invoked, because steps below aren't done yet —
  that's expected, not a bug.
- [x] **Monitoring page** — the admin dashboard's new **Data pipeline**
  panel. Live once you deploy this build.
- [ ] **Get a Kobo API token** *(your account — I cannot create this)*
- [ ] **Find your form's asset id(s)** *(your Kobo account — I don't know
  which forms you use or what they ask)*
- [ ] **Set the three secrets** *(CLI — see below)*
- [ ] **Choose how it's scheduled** *(dashboard — see below, two options)*

## 1. Get a Kobo API token

**Kobo account → Account Settings → Security → API Token.** Copy it —
this is what goes in step 3 below. Never paste it into chat with me; the
whole point of this design is that I never see or hold it.

If your KoboToolbox account isn't on the default server
(`kf.kobotoolbox.org` — e.g. the EU server, or a self-hosted instance),
note its base URL too; you'll set that as `KOBO_BASE_URL` in step 3.

## 2. Find your form's asset id(s)

Open the form in Kobo → the id is in the URL:
`.../#/forms/aXXXXXXXXXXXXXXXXXXXXXXXX/...` — that `aXXX...` string. One
form, one id; sync as many forms as you like, comma-separated (step 3).

## 3. Set the secrets

```bash
supabase login
supabase link --project-ref zptupvyrwoeabncxabgj
supabase secrets set KOBO_API_TOKEN=your-token-here
supabase secrets set KOBO_FORM_IDS=aXXXXXXXXXXXXXXXXXXXXXXXX,aYYYYYYYYYYYYYYYYYYYYYYYY
```

Only set `KOBO_BASE_URL` if you're not on the default server:

```bash
supabase secrets set KOBO_BASE_URL=https://eu.kobotoolbox.org
```

## 4. Choose how it's scheduled

`kobo-sync` does nothing on its own — something has to call it
periodically. Two ways, pick one:

**Recommended — Supabase's own Edge Function Cron Trigger** (no SQL, no
secret ever touches the database): **Dashboard → Edge Functions →
kobo-sync → Cron** → add a schedule, e.g. every 15 minutes
(`*/15 * * * *`). Simplest, and keeps the secret key entirely out of
Postgres.

**Alternative — `pg_cron` + `pg_net`**, if you'd rather it live in the
database. Needs the `pg_cron` and `pg_net` extensions enabled
(**Database → Extensions**) and your project's own secret key stored in
Vault — run this yourself in the SQL Editor (the placeholder is exactly
that; I never see the real value):

```sql
select vault.create_secret('sb_secret_...', 'kobo_sync_invoker');

select cron.schedule(
  'kobo-sync-every-15-min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://zptupvyrwoeabncxabgj.supabase.co/functions/v1/kobo-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'kobo_sync_invoker')
    )
  );
  $$
);
```

## 5. Try it

However you scheduled it, trigger one run and then open **My Dashboard →
Admin → Data pipeline**. A working sync shows a non-zero "Total
submissions" and "Last successful sync" a few seconds old. **Supabase
Dashboard → Edge Functions → kobo-sync → Logs** is the first place to
look if it doesn't.

## What the pipeline actually retains, per submission

Exactly what was asked, mapped onto real columns:

| Required field | Column | Notes |
|---|---|---|
| Kobo submission ID | `kobo_submissions.kobo_submission_id` | Kobo's `_id`/`_uuid`; globally unique, enforced by a real constraint |
| Form ID | `form_id` | Kobo's asset uid |
| Source | `source` | `'kobo'` — a fixed default, not a hardcoded assumption; the column exists for a second source later |
| `submitted_at` | `submitted_at` | Kobo's `_submission_time` |
| `received_at` | `received_at` | When this pipeline actually stored it |
| Processing status | `processing_status` | The six-value lifecycle below |
| Validation status | `validation_status` | `pending` / `passed` / `failed` — the validation *stage's own* verdict, independent of where the row now sits in the lifecycle; `validation_errors` (jsonb) says why |
| Raw payload reference | `raw_payload_id` | Points at `kobo_raw_payloads` — the untouched JSON, in its own immutable table, never the mutable processing row |

## Processing status — the six values, what moves a row between them

`RECEIVED → VALIDATED → PROCESSED`, with `DUPLICATE` / `REQUIRES_REVIEW` /
`REJECTED` as the offramps:

| Status | Set when |
|---|---|
| `RECEIVED` | The raw payload is stored — the instant a submission exists in this pipeline at all |
| `VALIDATED` | Passed the baseline structural checks (has an id, has a parseable `_submission_time`, has at least one answer field) |
| `PROCESSED` | Validated, and no content-identical submission already exists for this form |
| `DUPLICATE` | A different Kobo submission id, same form, whose answers hash identically to one already on file — an accidental re-submit, not a re-poll of the same id (that case is silently idempotent at the raw layer and never even reaches `kobo_submissions` a second time) |
| `REQUIRES_REVIEW` | Failed a baseline check that's recoverable — missing date, no answers — real data still worth a human look, not written off |
| `REJECTED` | The one unrecoverable case: no Kobo submission id at all, so the row can't even be tracked |

**Never silently discarded, concretely:** the raw payload is written
*before* any of validate/transform/dedup runs, and every one of those
stages only ever advances or annotates a row's status — none of them can
make a submission vanish. Even a submission whose *processed* row fails
to insert (a genuine, logged edge case) still has its raw payload
permanently on file, referenced by nothing yet rather than gone.

## Why deduplication is content-hash based, not field-based

This pipeline doesn't know any specific Kobo form's question schema, so it
can't judge "these two submissions are about the same event" the way a
human reviewing actual field-report data could. What it *can* do
honestly: hash the submission's answers (SHA-256, sorted keys, Kobo's own
system fields excluded) and compare against every other submission for
the same form. An exact match is very likely a genuine accidental
re-submit; anything less than exact is left as two separate `PROCESSED`
rows rather than a guessed match with false precision. Tightening this
once real form schemas are known — e.g. matching on "same school, same
date, same visit type" — is a natural follow-up, not something this pass
invents without the schema to justify it.

## Why "transformation" doesn't write into an existing table like `field_reports`

The requested architecture ends at "PostgreSQL → HPF Portal," and that's
exactly what this ships: a complete, queryable, deduplicated landing zone
in this project's own database. Mapping a *specific* Kobo form onto a
*specific* existing domain table (field visits, attendance, M&E values —
`me_indicator_values.source` already has a `'kobo_submission'` enum value
waiting for exactly this) needs to know that form's actual questions,
which this pass doesn't have. `transformed_data` (jsonb: `meta` vs.
`answers`, Kobo's system fields separated from the real content) is the
generic version of that step — the same "schema now, wiring later" shape
patch-13's other 21 tables already used, not a gap unique to this feature.

## Monitoring page

**My Dashboard → Admin → Data pipeline.** Everything on it:

| Metric | Reads |
|---|---|
| Total submissions | `count(*)` on `kobo_submissions` |
| Successful | `processing_status = PROCESSED` |
| Failed | `processing_status = REJECTED` |
| Duplicates | `processing_status = DUPLICATE` |
| Records requiring review | `processing_status = REQUIRES_REVIEW` |
| In progress | `RECEIVED` + `VALIDATED` (an extra, honest catch-all so the six statuses are fully accounted for, not just the four named ones) |
| Last successful synchronization | Most recent `kobo_sync_runs` row with `status = 'success'` |
| Last failed synchronization | Most recent `kobo_sync_runs` row with `status = 'failed'` |

Plus the 50 most recent submissions (status, form, Kobo id, timestamps,
and the error detail for anything not `PROCESSED`), and a CSV export of
that list. **Read-only, all the way down**: none of the three tables has
an insert/update/delete policy for `authenticated` at all — every row
was written by `kobo-sync` using the secret key, which bypasses RLS
entirely. Nobody, including Admin, can create/edit/delete a pipeline
record through the app or the REST API.

## Authorization

No new permission module. `kobo_submissions` already existed
(patch-13/23) scoped to `has_perm('me', 'view')` — Monitoring &
evaluation — with no write policy for anyone. The two new tables
(`kobo_raw_payloads`, `kobo_sync_runs`) got the identical shape rather
than a separate module invented for the same pipeline at a different
stage. In practice: Admin, Programme Manager, and M&E can see the
monitoring page (every role that reaches the admin dashboard at all,
per `BODIES` in `dashboards.js`); Field Officer, School Leader, Teacher,
and Learner cannot reach this page in the first place.

## If something goes wrong

| What you see | Cause |
|---|---|
| "Data pipeline" shows all zeros, no error | Not synced yet — go through steps 1–4 |
| A failed sync run with "KOBO_API_TOKEN is not configured" | Step 3 not done, or the secret name is misspelled |
| A failed sync run with "KOBO_FORM_IDS is not configured" | Step 3's second secret not set |
| A failed sync run with `Kobo API 401` | Wrong or expired token |
| A failed sync run with `Kobo API 404` | Wrong form id, or `KOBO_BASE_URL` pointed at the wrong Kobo server |
| Submissions stuck at `REQUIRES_REVIEW` | Check `error_detail` on that row (or `validation_errors`) — usually a missing/odd `_submission_time` |
| Numbers not moving even though the schedule is set | **Supabase Dashboard → Edge Functions → kobo-sync → Logs**, or check whether the cron trigger (step 4) is actually enabled |

## Files

| File | Purpose |
|---|---|
| `patch-29-kobo-pipeline.sql` | `kobo_raw_payloads`, `kobo_sync_runs`, reshapes `kobo_submissions` — applied live |
| `functions/kobo-sync/index.ts` | The ingestion service — fetch, validate, transform, deduplicate, insert — deployed live |
