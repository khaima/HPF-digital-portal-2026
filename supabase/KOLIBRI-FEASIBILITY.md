# Kolibri integration — feasibility & architecture assessment

**Status: DRAFT — pending approval. No integration code has been written.**
This document evaluates *how* real Kolibri data could reach the HPF Portal
and recommends one of three options. It does not implement anything —
see [What this document does NOT do](#what-this-document-does-not-do).

## 1. Current state (verified live, 2026-09-01)

Three tables already exist and are already **read** by School 360, Teacher
360, and Learner 360 (`dashboards.js`, Digital Engagement / ICT Adoption
panels — see [SCHOOL-360.md](SCHOOL-360.md), [TEACHER-360.md](TEACHER-360.md),
[LEARNER-360.md](LEARNER-360.md)):

| Table | Columns | RLS |
|---|---|---|
| `kolibri_activity` | `content_id`, `learner_id`, `progress_pct`, `time_spent_seconds`, `kolibri_session_id`, `synced_at` | `has_perm('library', ...)` + `activity_visible(learner_id)`, same shape on all four tables |
| `library_activity` | `content_id`, `learner_id`, `action`, `occurred_at` | ″ |
| `learning_activity` | `learner_id`, `activity_type`, `ref_table`/`ref_id` (polymorphic), `occurred_at` | ″ |

All three are **0 rows, and have been since creation**. Every column that
would identify *which* Kolibri deployment or facility a row came from is
absent — there is no `facility_id`, no `kolibri_instance_url`, nothing to
disambiguate one school's Kolibri box from another's if more than one ever
writes here. RLS already has an INSERT policy gated on `has_perm('library',
'create')`, so a producer can be wired in later without a schema or policy
change — but nothing currently holds that permission's credential, because
nothing currently authenticates as a producer. This confirms the premise
of this task exactly: **consumers exist, a producer does not.**

`supabase/SCHEMA.md`'s current text ("None of the four are wired to any
UI yet") predates the Learner 360 build and is now stale on that one
point — worth a follow-up doc fix, out of scope here.

## 2. What Kolibri actually is (verified against Learning Equality's own docs)

Kolibri ([learningequality.org/kolibri](https://learningequality.org/kolibri/))
is Learning Equality's offline-first learning platform, built specifically
for low-connectivity contexts — which is *why* it's the right fit for HPF's
rural Kenyan schools, and also *why* its architecture resists a live cloud
integration. The two facts below drive most of this assessment:

**Deployment topology.** A Kolibri installation is a self-contained local
server — commonly a Raspberry Pi or a repurposed laptop — running its own
web server (nginx) on a static local IP (typically `192.168.4.1`),
broadcasting its own Wi-Fi hotspot for the classroom to connect to. It
ships with bundled dependencies, a local SQLite database, and local content
storage, explicitly so a school with no internet at all can run it
end-to-end. There is normally **one such box per school**, sitting on a
LAN with no public IP and no path in from the internet by default.
[Source: Kolibri offline setup / Raspberry Pi tutorial](https://kolibri.readthedocs.io/en/release-v0.12.x/install/tutorials/rpi.html)

**Sync model.** Kolibri instances sync to each other or to a central
target using **Morango**, Learning Equality's own Django database-
replication engine, over a certificate-based peer-to-peer protocol built
for low-bandwidth links. The one hosted central target Morango can sync
to — **Kolibri Data Portal (KDP)** — is explicitly **closed beta**:
Learning Equality states it is available only to "a few pilot
organizations on a contractual basis," with public availability undecided.
[Source: Learning Equality Community — "What is Kolibri Data Portal"](https://community.learningequality.org/t/what-is-kolibri-data-portal/2916),
[Morango overview](https://morango.readthedocs.io/en/latest/overview/index.html)

### The 11 investigation points

| # | Point | Finding |
|---|---|---|
| 1 | Available APIs | A Django REST API exists (session-cookie + CSRF auth, e.g. `ContentSummaryLogViewSet`, `ContentSessionLogViewSet`, `AttemptLogViewSet`, filterable by `user_id`/`content_id`/facility). Designed for the browser talking to its own local instance, not for a remote server. [Source: Kolibri API auth docs](https://mintlify.wiki/learningequality/kolibri/api/authentication) |
| 2 | Data exports | Two independent export paths: (a) Coach report CSV downloads (per lesson/quiz, GUI-only); (b) Facility → Data tab → "Generate log file" for **Session logs** and **Summary logs**, plus a full user/class CSV — all producible headlessly via `kolibri manage exportlogs --log-type session\|summary`, run **on the Kolibri box itself**. [Source: Kolibri Data user guide](https://kolibri.readthedocs.io/en/latest/manage/data.html), [command-line docs](https://kolibri.readthedocs.io/en/latest/manage/command_line.html) |
| 3 | Available identifiers | Per-user: a database UUID, plus an admin-settable free-text `identifier` field meant for exactly this kind of external mapping — nothing populates it automatically today. |
| 4 | Learner identifiers | Kolibri's own learner UUID is stable *within* a facility, but nothing links it to `learners.id` unless HPF deliberately writes an HPF learner id into that `identifier` field when creating each Kolibri account — the same "no shared identity space" problem already documented for `enrollments`/`submissions` in [LEARNER-360.md](LEARNER-360.md). |
| 5 | Facility/school identifiers | A "Facility" is Kolibri's own top-level partition — in practice one Kolibri box = one facility = (assumed) one school, but nothing in Kolibri enforces that assumption, and today's schema has no `facility_id` column to record it even if confirmed. |
| 6 | Activity data | `ContentSummaryLog` (progress %, total time, completion) and `ContentSessionLog` (per-visit sessions) — this is exactly what `kolibri_activity` already models (`progress_pct`, `time_spent_seconds`, `kolibri_session_id`). |
| 7 | Resource usage | Content-level engagement (which video/exercise/reading, how long) is present in the same logs above, keyed by `content_id`. |
| 8 | Assessment information | `AttemptLog` (per-question quiz/exam attempts) exists and is exportable the same way, but nothing in HPF's schema currently models Kolibri-specific assessment attempts — `kolibri_activity` only carries aggregate progress, not question-level detail. A future phase would need a new table or an extension of `assessments`/`submissions`. |
| 9 | Synchronization frequency | No fixed cadence — sync (to a peer, or to KDP) is admin-triggered ("click the SYNC button") or can be scripted on a schedule *by whoever administers that specific box*; there is no push notification when new data exists. |
| 10 | Authentication requirements | Session cookie + CSRF for the REST API; certificate-based peer auth for Morango syncs; a project token for KDP. **No documented long-lived API key meant for unattended server-to-server polling** — every path assumes either an interactive admin or a Morango-speaking peer. |
| 11 | Offline synchronization implications | This is the deployment's entire reason to exist: connectivity is assumed absent or intermittent. Any integration has to treat "no data for weeks, then a burst" as the normal case, not a failure case. |

## 3. Option comparison

| Criterion | A — Real API integration | B — Scheduled/manual import | C — Deprioritize |
|---|---|---|---|
| Accuracy | High *if reachable* — direct, near-real-time | Medium–high — real data, freshness bound to export cadence | N/A |
| Security | **Poor** — requires exposing a classroom device's local API to the internet (port-forward/VPN/public IP), holding facility user records incl. hashed passwords, on hardware nobody is provisioned to harden | Good — no inbound exposure ever; a CSV file carries no live credential | No new exposure |
| Maintenance | High — per-school tunnel/VPN, session+CSRF login script that breaks on any Kolibri upgrade, one secret set per school (vs. Kobo's single account-wide token) | Moderate — one central ingestion pipeline, reusable across every school; needs occasional CSV-schema drift checks | None |
| Offline compatibility | **Poor — actively fights the platform's own design** | **Excellent — this *is* the platform's design**; matches HPF's existing field-visit cadence | N/A (stays empty) |
| Cost | Ongoing (connectivity/VPN infra per school, or a wait for school connectivity to improve) | Low (reuses Supabase Storage/Edge Function patterns already built for Kobo) | Zero |
| Complexity | High — dozens of independent, version-sensitive integration targets | Moderate — one CSV parser + validate/dedup pipeline, conceptually the same raw→validate→transform→dedup shape `kobo-sync` already proved out | Zero |
| Scalability | **Poor** — complexity scales linearly with the number of physical Kolibri boxes | Good — adding a school means training staff on one CLI command, not standing up new infrastructure | N/A |
| Data completeness | High in theory, undermined by low real-world uptime | Good, with a known and honestly-reportable lag | None — stays at 0 rows |
| HPF reporting value | High in theory | High and realistic — matches how `school_returns` already works (periodic, field-visit-driven) | None gained, but no false claims either |

## 4. Recommendation

**Option B — scheduled/manual data import.**

Kolibri's own architecture is the deciding factor, not a preference: the
same offline-first design that makes Kolibri the right tool for HPF's
rural schools is exactly what makes Option A impractical — there is no
supported way to poll a Kolibri box's API from the cloud without fighting
the platform, and the one hosted sync target built for this (Kolibri Data
Portal) is closed-beta and would require a business/contractual
relationship with Learning Equality, not an engineering decision HPF can
make unilaterally.

Option B instead treats a Kolibri box the way `kobo-sync` already treats
Kobo — a raw payload arrives, gets validated, transformed, and
deduplicated before landing in `kolibri_activity`/`learning_activity` —
except the "fetch" step becomes "receive a CSV a field officer or teacher
uploaded" rather than "call a remote API," which matches connectivity
reality instead of assuming it away. HPF already has the operational
pattern for this: `field_visits`/`field_officers` means someone
periodically reaches every school in person already.

Option C is not recommended outright, but is the honest fallback if HPF
decides Kolibri usage data isn't worth the ingestion pipeline right now —
the three tables would simply stay accurately documented as empty, same
as today.

## 5. What Option B would actually require (design-level, not built here)

Not built in this pass — listed so an approval decision has something
concrete to approve:

1. A `kolibri_facilities`-type mapping (which physical box/facility →
   which `schools.id`) — the identifier gap in point 5 above needs an
   explicit answer, not an assumption.
2. A learner-identity bridge — either HPF starts writing `learners.id`
   into each Kolibri account's `identifier` field going forward, or
   imports land as `REQUIRES_REVIEW` pending a manual name match, the same
   honest fallback `kobo-sync` already uses for its own identity gaps.
3. An upload surface — most likely an admin-dashboard file upload (CSV in,
   same validate/transform/dedup shape as `kobo-sync`) rather than a new
   Edge Function endpoint reachable from outside Supabase.
4. A decision on assessment data (point 8) — whether `AttemptLog` detail
   is in scope for a first pass, or deferred behind aggregate progress.

## What this document does NOT do

- No new tables, columns, or migrations.
- No Edge Function, no client code, no CSV parser.
- No credentials, endpoints, or facility mappings configured.
- No decision made on HPF's behalf — §4 is a recommendation, not an
  approval.
