# Human Practice Foundation — Digital Portal

**Live:** https://khaima.github.io/HPF-digital-portal-2026/ (canonical) ·
https://hpf-digital-portal-2026.vercel.app (also supported, see
[`VERCEL.md`](VERCEL.md))

Accurate as of **31 August 2026**. This file replaces an earlier version
that described a pre-migration, localStorage-only build of this
project — that architecture no longer exists anywhere in this repository.
Every claim below was checked against the actual source and the live
Supabase project before this file was written; see §9 for how to verify
any of it yourself.

Status labels used throughout: **WORKING** (real, in production use),
**PARTIALLY WORKING** (real code/schema, but missing a piece — usually
credentials, a producer, or a decision — before it's actually useful),
**PLANNED** (no working implementation exists yet).

---

## 1. What the system does

A programme-management portal for Human Practice Foundation's education
work in Kenya. Real, Postgres-backed functionality today: a master data
registry for schools/teachers/learners/devices/infrastructure; termly
return filing with a correction trail; field-officer visit reporting;
class/coursework authoring and results; a role-based permission system;
an audit trail; an M&E indicator/target/scorecard system; a Kobo
ingestion pipeline (built, not yet connected to a real Kobo account); and
a public-facing set of informational pages (home, curriculum, learning
resources, assessment tools) plus a Community Resources AI chat.

It is **not** a finished end-to-end learning platform. The learner's own
"My Dashboard" view (course progress, streaks, badges, a content
catalogue) is placeholder content — see §5 and §8.

## 2. Current architecture

A static, no-build, dependency-free single-page application talking
directly to a Supabase backend. No React/Vue/Svelte, no bundler, no
`package.json` — what's on `main` is byte-for-byte what's deployed.

```
index.html → app.js (router, Auth, Repo, field-officer portal)
                 │
                 ├─ dashboards.js   (11,489 ln — every role dashboard,
                 │                   Master Data Management, the "360"
                 │                   entity profiles, the Kobo pipeline
                 │                   monitor, the Impact Scorecard)
                 ├─ recovery.js     (password/username recovery, signup
                 │                   email confirmation)
                 ├─ data.js         (static content + the remaining
                 │                   placeholder data, see §5/§8)
                 ├─ util.js         (localStorage helpers, toast(), the
                 │                   deployment-portable BASE constant)
                 └─ supabase.js     (client factory, error translator)
                       │
                       ▼
                 Supabase
                   ├─ PostgreSQL — 45 tables, 160 RLS policies
                   ├─ Supabase Auth
                   └─ Edge Functions — kobo-sync, community-resources-chat
```

Deployed to two targets from the same source — see §10.

## 3. Authentication architecture

Four coexisting paths, each for a structurally different reason (full
detail: [`supabase/AUTH-RBAC.md`](supabase/AUTH-RBAC.md)):

| Path | Status | How |
|---|---|---|
| Teacher / School Leader / Field Officer | **WORKING** | Real Supabase Auth, self-serve signup, email confirmation required (`patch-25`) |
| Admin / Programme Manager / M&E | **WORKING** | Real Supabase Auth, admin-invited only (magic link), forced password set on first sign-in (`needs_password`) |
| Learner | **WORKING, by design — not a gap** | Username/password checked against `localStorage["hpf_users"]`. A learner has no email address, Supabase Auth requires one, and RLS is JWT-based — there is no version of this that becomes a Postgres row without giving learners real identities first, which is a product decision, not a migration. See *Why learners stay local* in [`supabase/STORAGE-AUDIT.md`](supabase/STORAGE-AUDIT.md). |
| Legacy local accounts | **PARTIALLY WORKING — transitional, not managed** | Pre-Supabase-migration staff accounts, same local check as learners, explicitly flagged in the UI as not reaching the database. No sunset mechanism exists yet (§8). |

**Password reset is code-only** (no emailed link) as of this session —
institutional mail-gateway link-prefetching was silently burning
one-time links before the real person clicked them. Signup confirmation
and username recovery still offer both a link and a code. Full detail:
[`supabase/AUTH-RECOVERY.md`](supabase/AUTH-RECOVERY.md).

## 4. Authorization / RLS architecture

**160 RLS policies across all 45 tables — zero tables without RLS**
(verified live). Every policy follows one pattern:

```
has_perm(module, action) AND <row scope>
```

`has_perm()` answers "may this *role* do this *kind* of thing at all" —
a live lookup against `app_modules`/`permissions` (16 modules × 7 roles ×
up to 6 actions). The row-scope half answers "to *this* row" — own
class, own school, assigned school, and so on. Both halves are required
on every policy; neither is sufficient alone. Built on a reused
vocabulary of `SECURITY DEFINER` helpers (`has_perm()`, `is_admin()`,
`is_staff()`, `owns_class()`, `assigned_to_school()`, `teaches_learner()`)
rather than one-off logic per table.

**Roles** (`user_role` enum + the `roles` table): `admin`,
`programme_manager`, `me_officer`, `field_officer`, `school_leader`,
`teacher`, `learner`. The full role × module × action matrix, with the
reasoning behind each grant, is documented in
[`supabase/AUTH-RBAC.md`](supabase/AUTH-RBAC.md) — including 24
rolled-back-transaction test scenarios run against the live database, not
just asserted from the policy text.

Append-only tables (`audit_logs`, `kobo_raw_payloads`, `kobo_sync_runs`,
`kobo_submissions`) have **no** insert/update/delete policy for
`authenticated` at all — every row in them is written by a
`SECURITY DEFINER` trigger or an Edge Function using the project's secret
key, both of which bypass RLS entirely. Nobody, including Admin, can
write to those tables through the app or the REST API.

## 5. Current modules

| Module | Status | Notes |
|---|---|---|
| Master Data Management (Schools, Teachers, Learners, School Leaders, Devices, Infrastructure) | **WORKING** | Full CRUD, duplicate detection, archive-not-delete, matrix-gated. [`supabase/MDM.md`](supabase/MDM.md) |
| School 360 / Teacher 360 / Learner 360 | **WORKING** | Read-only, computed entity profiles opened from MDM. [`supabase/SCHOOL-360.md`](supabase/SCHOOL-360.md), [`TEACHER-360.md`](supabase/TEACHER-360.md), [`LEARNER-360.md`](supabase/LEARNER-360.md) |
| Termly returns (with correction trail) | **WORKING** | `school_returns` + grades + revisions |
| Field reports | **WORKING** | Real Postgres insert; offline outbox for genuine connectivity failures (§7) |
| Coursework (classes, assignments, assessments, submissions) | **WORKING** | Teacher-authored content is direct-to-Postgres; a learner's own results are recorded locally first and synced through the teacher's own session, since a learner has no JWT to write with directly |
| Impact Scorecard / M&E indicators & targets | **WORKING** | Real create/edit UI for indicators and targets, not just value display |
| Audit log | **WORKING** | 13 tables have a real audit trail — 11 via a shared `audit_row_change()` trigger (`patch-24`, extended to `teachers`/`learners`/`field_officers` by `patch-27`), plus `permissions` and `profiles` each via their own dedicated logger. Deliberately not attached to high-volume tables (attendance, submissions) |
| Data pipeline monitoring (Kobo) | **WORKING as a monitor, PARTIALLY WORKING as a pipeline** | The monitoring page is real; the pipeline behind it has ingested zero submissions so far — see §6/§16 |
| Community Resources chat | **WORKING** | Public, no login required, backed by an Edge Function |
| Digital Library | **WORKING** | Backed by `digital_learning`, not local storage |
| Notifications | **PLANNED** | `notifications` table + RLS exist; no producer or consumer UI has been built |
| Learner's own "My Dashboard" | **PLANNED** | Course progress, streaks, badges, and the content catalogue are static placeholder content (`data.js`). No real per-learner analytics exist yet — this needs a product decision (what a "streak" means here) before it needs code |

## 6. Current integrations

| Integration | Status | Detail |
|---|---|---|
| Supabase (Postgres, Auth, Edge Functions) | **WORKING** | The primary datastore; see §2–§4, §11–§13 |
| Anthropic (Community Resources chat) | **WORKING** | `community-resources-chat` Edge Function, deployed and active; degrades to a plain error message rather than failing hard if its API key secret isn't set |
| KoboToolbox | **PARTIALLY WORKING** | `kobo-sync` Edge Function deployed and active; the pipeline is fully built (`kobo_raw_payloads` → validate → transform → deduplicate → `kobo_submissions`) but has never been invoked with real credentials — 0 rows in production. See §16. |
| Kolibri | **PLANNED — no integration exists** | There is no Kolibri API client, credential, or connection anywhere in this codebase. `kolibri_activity`/`library_activity`/`learning_activity` tables exist and are now *read* by the three "360" profiles above, but nothing writes to them — they are permanently empty until a real integration is built. The learner dashboard's "Kolibri-style" UI is unrelated static content (§5), not a real Kolibri connection. |

## 7. Offline capability

**One real feature, not general offline support.** The field officer's
report form queues to `localStorage["hpf_fo_outbox"]` specifically when a
submission fails to reach Postgres for a genuine connectivity reason (not
a permission refusal, which surfaces immediately) — draining
automatically on reconnect. That is the entire scope of offline
capability in this application today.

There is **no service worker, no cache manifest, no PWA manifest, and no
offline read access to any other data** anywhere in this codebase
(confirmed — none of these exist in any tracked file). Every other page
and panel requires a live connection.

## 8. Current limitations

- **Kolibri has no real integration** (§6) — its read-wired tables are
  permanently empty until one exists.
- **Notifications are schema-complete, functionally absent** (§5).
- **The learner's own dashboard is placeholder content**, identical for
  every learner regardless of what they actually do (§5).
- **Legacy local accounts have no sunset mechanism** — they can coexist
  with real Supabase accounts indefinitely with nothing tracking that
  toward zero.
- **File storage is inline `data:` URLs** in `digital_learning.url`, not
  a Supabase Storage bucket (none is used anywhere in this codebase).
  Fine for the small resources this was built for; a real ceiling for
  video or large PDF content.
- **Reporting is CSV export and live dashboard views only.** There is no
  scheduled or PDF-format report generation anywhere in this application.
- **No unit or integration tests exist for `dashboards.js`'s own logic**
  (§14) — CI (below) verifies the codebase is syntactically valid,
  correctly referenced, and serves; it does not verify any individual
  feature's behavior.
- **Only GitHub Pages' deploy is CI-gated.** Vercel deploys independently
  through its own Git integration, outside this repository's own
  `deploy.yml` — a push that fails CI still reaches Vercel today. See §10.
- **Vercel is a second deployment target, not fully equivalent in every
  operational respect** — see [`VERCEL.md`](VERCEL.md) for exactly what
  is and isn't covered.

## 9. Development setup

No install step. You need Python 3 (`python --version` or `py --version`).

**Windows:** `py server.py` (or double-click `start.bat`)
**macOS/Linux:** `python3 server.py` (or run `./start.sh`)

Then open **http://localhost:5173** (a different port: `py server.py 8080`).

`server.py` serves the static files directly and falls back to
`index.html` for any path with no matching file, so clean URLs like
`/curriculum` and `/dashboard` work locally on a hard refresh, the same
SPA-fallback shape both real deployments use (see `404.html`/`vercel.json`).

This connects to the **real, live Supabase project** — `config.js`'s
publishable key is checked in and safe to publish (RLS is what actually
gates access, not key secrecy). There is no seeded demo account and no
offline/mock mode; signing up creates a real account through the flows
in §3.

**To verify any claim in this document yourself:**
[`node .github/scripts/verify.mjs`](.github/scripts/verify.mjs) checks
syntax, references, and structure against the actual repository; the
Supabase facts throughout this file (45 tables, 160 policies, 30
migrations, the two Edge Functions) were re-confirmed live against the
production project immediately before this file was written.

## 10. Deployment

Two live targets, from the same `main` branch:

| Target | Mechanism | CI-gated? |
|---|---|---|
| **GitHub Pages** (canonical) | [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) mirrors `main` → `gh-pages` on every push | **Yes** — the `deploy` job has `needs: ci` and will not run if CI fails ([`CI.md`](CI.md)) |
| **Vercel** | A Git integration configured outside this repository, deploying zero-config as a static site; [`vercel.json`](vercel.json) supplies the SPA rewrite | **No** — Vercel's own build/deploy is independent of this repo's Actions; a commit that fails CI still reaches it today |

Both serve the identical static files and point at the identical Supabase
project — neither is a sandbox. See [`VERCEL.md`](VERCEL.md) for the
routing fix that made the second target viable at all, and §8 for the
CI-gating gap between them.

## 11. Supabase setup

Full step-by-step: [`supabase/SETUP.md`](supabase/SETUP.md) — creating
the project, running all 30 migrations in order (every one is safe to
re-run), creating the first admin, and configuring password-recovery
email delivery. This file doesn't repeat those steps; it points at the
one place they're kept current.

Related setup docs, one per feature area that needed its own:
[`AUTH-RBAC.md`](supabase/AUTH-RBAC.md),
[`AUTH-RECOVERY.md`](supabase/AUTH-RECOVERY.md),
[`MDM.md`](supabase/MDM.md),
[`SCHOOL-360.md`](supabase/SCHOOL-360.md) /
[`TEACHER-360.md`](supabase/TEACHER-360.md) /
[`LEARNER-360.md`](supabase/LEARNER-360.md),
[`KOBO-INTEGRATION.md`](supabase/KOBO-INTEGRATION.md),
[`COMMUNITY-RESOURCES.md`](supabase/COMMUNITY-RESOURCES.md),
[`STORAGE-AUDIT.md`](supabase/STORAGE-AUDIT.md),
[`SCHEMA.md`](supabase/SCHEMA.md).

## 12. Environment variables

| Where | Holds | Committed? |
|---|---|---|
| [`config.js`](config.js) | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | **Yes — deliberately.** Both are safe to publish; RLS is the actual access control, not key secrecy (see the file's own header comment). |
| `.env` (repo root) | `KOBO_API_TOKEN`, `KOBO_BASE_URL` | **No.** Gitignored, confirmed untracked, and not read by any application code today — see §16 on where these values actually need to go instead. |
| Edge Function secrets (`supabase secrets set ...`) | `ANTHROPIC_API_KEY` (`community-resources-chat`), `KOBO_API_TOKEN`/`KOBO_BASE_URL`/`KOBO_FORM_IDS` (`kobo-sync`) | **Never** — these live only in Supabase's own secret store, never in this repository in any form. |

**Never present anywhere in this repository:** a Supabase `service_role`
key, the database password, or any SMTP credential. CI now checks for
exactly this on every push — see §14/§15.

## 13. Database migrations

**30 applied, live, in order** — `schema.sql` then `patch-01` through
`patch-29` (plus `patch-16b`, `patch-22a`, `patch-23a`), confirmed against
the production project's own migration history, not inferred from the
SQL files alone. The full numbered list with what each one does is
[`supabase/SETUP.md`](supabase/SETUP.md)'s own table — this file doesn't
duplicate it. Every migration is additive and safe to re-run.

## 14. Testing

**Automated (new):** a CI pipeline runs before every deploy —
[`CI.md`](CI.md) documents all 8 checks in full
([`.github/workflows/ci.yml`](.github/workflows/ci.yml),
[`pr.yml`](.github/workflows/pr.yml)):
JavaScript syntax, JSON validity, broken local references, required
files present, no tracked secrets, no accidental demo credentials, every
route has a real handler, and smoke tests (both a real module-import
check and a real serve-and-fetch check against the actual static files).
A failing check stops the GitHub Pages deploy job from running at all.

**Manual:** [`TESTING.md`](TESTING.md) holds scripts for the flows CI
can't verify without a live inbox — does a password reset/signup
confirmation/username-recovery/staff-invite email actually arrive.

**Not yet automated:** unit or integration tests for `dashboards.js`'s
own business logic (§8) — the current pipeline verifies the codebase is
structurally sound, not that any individual feature behaves correctly.

## 15. Security rules

- **RLS is the access-control boundary, not key secrecy** — `config.js`'s
  publishable key is meant to be public (§4, §12).
- **No secret is ever committed** — verified by CI on every push (checks
  5–6, [`CI.md`](CI.md)).
- **Learner passwords are stored in plain text** in
  `localStorage["hpf_users"]` (never displayed, not hashed) — an
  accepted, documented limitation of the local-only learner-account
  design (§3), not an oversight.
- **Every sensitive write is auditable** — `audit_logs`, written only by
  `SECURITY DEFINER` triggers, append-only even for Admin (§4).
- **No demo or default credential exists anywhere in this application.**
  There is no seeded account, no hardcoded password, and no bypass —
  confirmed by CI check 6 and by direct inspection of every tracked file.
  Full findings: [`supabase/AUTH-RBAC.md`](supabase/AUTH-RBAC.md)'s own
  security section.

## 16. Kobo setup

Full step-by-step, including exactly which values are still needed and
why: [`supabase/KOBO-INTEGRATION.md`](supabase/KOBO-INTEGRATION.md).
Short version: the pipeline (`kobo-sync` Edge Function →
`kobo_raw_payloads` → validate/transform/deduplicate →
`kobo_submissions` → the Data Pipeline monitoring page) is fully built
and deployed. It needs three things only a Kobo account holder can
supply — an API token, the target form's asset ID, and a sync schedule —
none of which exist in this repository or its environment today. The
monitoring page will show real numbers once those are set.

## 17. Future roadmap

In the order each item unblocks the next — cross-referenced above to
where each gap is already documented in detail:

1. Turn on branch protection requiring the CI check to pass before a
   merge to `main` — a repository setting, not a workflow file (§14).
2. Decide whether Vercel's own deploy should also be gated by CI, or
   accept the current asymmetry (§8, §10).
3. Supply real Kobo credentials and a sync schedule (§16) — the pipeline
   is ready.
4. Decide Kolibri's real shape — a genuine API integration, a manual
   import process, or deprioritize it — before more UI is built against
   its permanently-empty tables (§6).
5. Plan the legacy-account sunset (a cutoff date, or a one-time forced
   migration prompt), then remove the local-account code path once the
   count reaches zero (§3, §8).
6. A product decision for what the learner's own dashboard should
   actually track — streaks, badges, and the content catalogue all need
   a real definition before any schema or code work makes sense (§5).
7. Wire `notifications` to real events, if a producer is ever needed (§5).
8. Add unit/integration test coverage for `dashboards.js`'s own logic,
   beyond what the current structural CI checks (§14).
