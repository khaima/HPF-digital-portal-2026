# HPF Digital Portal — Database Audit

Audit only. No application code was changed to produce this document. Findings below
are verified against the actual repository contents and the live Supabase project
(`zptupvyrwoeabncxabgj`), not against assumptions from the SQL files alone.

**Revised 2026-08-19 (twice).** The same audit was requested again, verbatim, a day after
the original pass — by then two of its own headline findings were no longer true, because
the migrations it recommended had since been built: `login_events` gained a real read
side, and `classes`/`enrollments` moved off `localStorage` entirely. Re-verified against
the live database and current source rather than quietly re-issuing stale numbers;
everything below reflects what the codebase and database actually contain right now.
The original pass's still-accurate findings are carried over unchanged.

**Second revision, same day.** A separate, explicit "real authentication" request
followed — not a repeat of the audit, but the audit's own §9 items 1–2 acted on: a new
`school_officer_assignments` table gives Field Officer "assigned schools" a real
mechanism (`patch-12-school-officer-assignments.sql`), and the previously-open
`school_returns`/`school_return_grades` read policies (`using (true)`, i.e. every
signed-in user reads every school's returns) were tightened to admin, the school's own
leader, or an officer assigned to that school. `school_return_revisions` was left at its
own-school-only scope, deliberately not extended to officers (see §3). The "Approve"
column from that request's permissions matrix was explicitly deferred — no workflow
exists for it yet, by the requester's own choice, and none of the changes below invent
one. This revision's changes are noted inline below rather than restated as a new pass.

**Third revision, 2026-08-20.** "Replace `data.js`" — the request that produced this
audit's §1 "standing in for live data" table in the first place — was acted on directly.
Everything in that table with a real data source now has one: admin's role breakdown/
weekly logins/recent activity (real, from `profiles`+the merged event set), the field
officer's own dashboard (real, from `school_officer_assignments`+`field_reports`), the
school leader's stat tiles and attendance trend (real, from `school_returns`), and the
teacher's "Class activity" panel. The five previously-unconnected coursework tables —
`assignments`, `assignment_results`, `assessments`, `questions`, `submissions` — are now
fully wired: the teacher-authoring side writes straight to Postgres, and a background
sync (`syncResults()`) pushes locally-recorded learner results up through the teacher's
own session, since a learner never has a JWT to write with directly. Anything left with
no real data source — a field officer's per-school "health" score, teacher coaching
ratings, learner streaks/badges, the Khan-Academy-style content catalogue
(`KOLIBRI.learner`) — was deliberately given an honest "not yet tracked" state rather
than an invented number, per the requester's own choice when asked. Full detail in this
session's three commits (`4983f43`, `e360426`, `832225e`); everything below reflects the
result rather than repeating them.

**Fourth revision, 2026-08-20.** A direct request to "build the HPF data model" — a
27-table target schema — landed as `patch-13-data-model-expansion.sql`, adding 21 tables:
`roles`, `school_programmes`, `school_facilities`, `teachers`, `field_officers`,
`teacher_training`, `learners`, `subjects`, `digital_learning`, `kolibri_activity`,
`library_activity`, `learning_activity`, `field_visits`, `field_visit_findings`,
`devices`, `device_maintenance`, `kobo_submissions`, `interventions`, `action_items`,
`notifications`, `audit_logs` — plus additive FKs (`profiles.role`→`roles`,
`enrollments.learner_id`→the new `learners` table, repointed off a structurally-dead FK
to `profiles` it had carried since before `learners` existed; `assignments.subject_id`
and `assessments.subject_id`→`subjects`). This is schema only, by explicit choice — see
§4a. Two names on the requested list were deliberately not duplicated: `submissions`
already is what "assessment_results" would hold, and `field_reports` stays the live
table the field-officer portal actually uses (`field_visits`/`field_visit_findings` are
the future-shaped version, not a competing live implementation). Full reasoning and
verification in the `patch_13_data_model_expansion` migration and this session's commit.

**Fifth revision, 2026-08-20.** "Redesign your dashboard" landed a new lead section on
the admin dashboard, `programmeOverview()` in `dashboards.js` — 4 stat tiles
(Schools/Teachers/Learners/Digital), 4 programme-performance meters (Learning/Teacher
ICT/Digital Use/Attendance), a per-school performance table, and a real, computed
priority-actions list. Everything below it (filters, the Impact Scorecard, login inbox,
admin accounts, officer assignments, user management, digital library) is untouched, per
the requester's own choice when asked. Every number reuses a cache `wireAdmin()` already
loads at mount (`schoolsCache`, `returnsCache`, `classesCache`, `profilesCache`) plus one
small new one (`deviceIssuesCache`, open `device_maintenance` rows) — no new per-render
queries. "Digital" (the tile, the meter, the table column) has no real data source
anywhere in the schema yet (`digital_learning`/`kolibri_activity`/`library_activity`,
built in the previous revision, are still empty) and renders an honest "—"/"not yet
tracked" rather than an invented percentage. A school's Status dot is a real derived
signal — the latest filed `school_returns` row's attendance rate and dropout rate — not
an invented score, the same substitution principle used for the field officer's "health
score" two revisions ago. Priority actions are real too: schools at risk or missing a
return, teachers with an empty class, open device-maintenance tickets — each line only
renders when its count is actually above zero.

---

## 0. How the app is put together

| File | Role |
|---|---|
| `config.js` | Supabase project URL + publishable (anon) key. Committed — safe to publish, per its own header comment; access control lives in RLS, not key secrecy. |
| `supabase.js` | Creates the shared `supabase` client (session-persisting) and `adminClient()` (a throwaway client used only so creating a new admin doesn't sign the acting admin out). Exports `authMessage()`, a Postgres/Supabase-error-to-human-text translator used everywhere a write can fail. |
| `data.js` | 23 exported constants — mostly genuine static content (nav copy, county lists, form option lists) since 2026-08-20's pass; the shrinking remainder is **seed/demo data standing in for a live query** (`DASH.learner`, `KOLIBRI.learner`, `LIBRARY_SEED`). This audit only flags that remainder as "simulated." |
| `app.js` | Router, `Auth` (sign-up/sign-in for both real Supabase accounts and local-only learners), `Repo` (login/signup event logging), field officer portal, community resources chat, recovery-flow wiring. |
| `dashboards.js` | All five role dashboards (admin/teacher/learner/field_officer/school_leader), the admin analytics/scorecard suite, school-leader termly returns, schools map, the coach workspace's assignment/assessment authoring. 7,400+ lines — the bulk of the app. |
| `recovery.js` | Forgot-password / forgot-username flows. Calls real `supabase.auth.*` methods throughout — not a stub, see §7. |
| `supabase/` | 13 SQL files (`schema.sql` + `patch-01` … `patch-13`) plus `SETUP.md`. Confirmed to match the live database exactly (§4, §4a) — no drift between what's committed and what's deployed. |

---

## 1. Data currently sourced from `data.js`

Genuinely static (no Supabase table would improve these — they're copy/config, not records):

`PORTAL_CARDS`, `CURRICULUM`, `RESOURCES`, `ASSESSMENT`, `IMPACT`, `EMPOWERMENT_MODEL`,
`ABOUT_POINTS`, `ROLES`, `ORG_TYPES`, `COUNTIES`, `HERO_QUOTES`, `HERO_SLIDES`,
`LIBRARY_CATEGORIES`, `RESOURCE_TYPES`, `REGIONS`/`SCHOOLS` *(fallback only, see §3)*,
`PROJECTS`, `VISIT_TYPES`, `CONTENT_KINDS`,
`KPI_TARGETS` *(deliberately-static programme targets, not a measurement)*.
`DASH.teacher` and `KOLIBRI.coach` were deleted outright on 2026-08-20, confirmed dead
(nothing read them any more once the coach dashboard's one remaining consumer —
"Class activity" — moved to real local submission data).

**Note on `REGIONS`:** its Isiolo/Narok lists were edited directly on GitHub outside
this workflow on 2026-08-19, pasted with curly "smart" quotes that are invalid in a JS
string literal — the syntax error broke every page (a parse failure in an imported
module fails the whole graph, not just the affected dropdown). Fixed same-day by
straightening the quotes and closing the array, content otherwise preserved as
authored. Mentioned here only because it demonstrates a real risk specific to this
file: it is plain, uncompiled JS committed directly, so a rich-text paste into GitHub's
web editor can take the entire site down, not just corrupt one field's data.

**Standing in for live data — what's left after 2026-08-20's pass:**

`DASH.admin`, `DASH.teacher`, `DASH.field_officer`, and `DASH.school_leader` are gone
entirely — every field they held either has a real source now or, where none exists,
renders `notTracked()` instead (see §6). Two categories remain, both blocked on more
than a data-layer swap:

| Export | What it fakes | Consumed by |
|---|---|---|
| `DASH.learner.*` | Course progress, day streak, badges | Learner dashboard, in full — blocked on the same "what does a streak mean in a real database" product question §10 already flagged, not on missing schema |
| `KOLIBRI.learner.*` | A Khan-Academy-style content catalogue (videos, exercises, channels) | Learner "Learning Resources" tab — this content was never real to begin with (no such library exists), so there's no table to connect to until someone decides what the real content model is |
| `LIBRARY_SEED` | 8 seed resources | `digitalLibraryPanel()` — merged with anything an admin has added locally via `hpf_library` |

---

## 2. Data currently in `localStorage`

Every key found across the codebase (`grep`-verified, not from memory):

| Key | Holds | Written by |
|---|---|---|
| `hpf_users` | All non-learner-Postgres accounts — really only meaningful now as the **legacy fallback** store (pre-migration accounts) and the admin's "User management" table, which is entirely local-only | `app.js` signup (learners), admin user-management edits |
| `hpf_session` | Current session mirror (both real-Supabase and local sessions) | `Auth.*`, admin "enter account" impersonation |
| `hpf_login_events` | Signup/login audit trail for learners and legacy accounts specifically — **as of 2026-08-19 this is by design, not a gap: see §3**, `Repo.allEvents()` now merges this with the real Postgres table for the admin's view | `Repo.recordLocal()` — learner logins only, by design |
| `hpf_impersonate` | Admin-is-viewing-as-another-user flag | Admin "enter account" |
| `hpf_classes` | **A hybrid mirror, permanently — not a residual migration gap.** As of 2026-08-20, class shell/roster *and* assignments/assessments/questions are all fetched from Postgres on mount and merged in here; only per-learner results/submissions are recorded locally first (§3, `syncResults()` pushes them to Postgres afterward). This store can never fully go away: learners have no Supabase session at all — RLS is JWT-based and a learner's browser has no JWT to present — so a learner's own view of "my assignments" (`liveSessionsFor`, `learnerAssignments`) can never become a direct client-side Postgres query, and a learner's own submission can never be written to Postgres directly either. That's a structural ceiling on this key, not an oversight to fix later. | Teacher coach UI (shell + coursework now via Postgres mirror; per-learner results direct-to-local, synced afterward) |
| `hpf_assignments` | (Legacy/secondary key, largely superseded by nesting under `hpf_classes`) | Older assignment-creation paths |
| `hpf_library` | Admin-curated Digital Library additions | `digitalLibraryPanel()` |
| `hpf_activities`, `hpf_custom_charts`, `hpf_chart_titles` | Admin-authored custom scorecard charts/activities | Scorecard "add activity"/"add chart" |
| `hpf_return_draft` | Autosave draft for the school-leader return form — **deliberately** local, not a gap (see the `d49c5b9` commit: a half-typed return should not publish partial figures to a table the scorecard reads) | `wireSchoolReturns()` |
| `hpf_fo_outbox` | Field reports that failed to reach Postgres due to a genuine connectivity failure, queued for retry — **deliberately** local, this is the offline-safety design for `field_reports`, not a gap | `wireFieldOfficer()` |
| `hpf_recover_intent` | Transient UI state during password/username recovery | `recovery.js` |

**The two rows above marked "deliberately local" are not migration targets** — they exist specifically because writing them to Postgres would be wrong (unverified partial data, or data that by definition hasn't reached the server yet). Everything else in this table is a real gap.

---

## 3. Functionality that already connects to Supabase

| Area | Status |
|---|---|
| **Auth (staff roles)** | Real. `teacher` / `school_leader` / `field_officer` / `admin` sign up and sign in via `supabase.auth.signUp/signInWithPassword`, get real JWTs, real hashed passwords. |
| **Auth (learners)** | Real Postgres is not used at all, **by design** — learners have no email and RLS is JWT-based, so a learner "account" is a username/password pair validated against `hpf_users` in localStorage. Documented in `app.js` (`isLearnerRole` comment). |
| **Legacy account fallback** | Real, and deliberate — accounts created before the Supabase migration still authenticate locally (`legacyLogin()`), flagged so the UI can warn that nothing they do will reach the database. |
| **Password/username recovery** | Real Supabase Auth calls throughout (`resetPasswordForEmail`, `signInWithOtp`, `verifyOtp`, `updateUser`, `auth.resend`) — **but non-functional in practice**, because the project has no SMTP configured. This is an infrastructure gap, not a code gap — see §7. |
| **`schools`** | Full CRUD via Supabase. Read by the map/scorecard/signup county-school cascade with a `SCHOOLS`/`REGIONS` static fallback if the fetch hasn't resolved yet. |
| **`school_returns` + `school_return_grades` + `school_return_revisions`** | Full CRUD, RLS-scoped to the head's own school, audit-trailed corrections, feeds the scorecard's "School Returns" panel. **Read tightened 2026-08-19** (`patch-12`): was `using (true)` — any signed-in user read every school's returns — now admin, the school's own leader, or an officer assigned to that school (`assigned_to_school()`). `school_return_revisions` kept at admin/own-school only, not extended to officers. |
| **`field_reports`** | Full CRUD as of this session's prior work (commit `129a781`) — real insert with an offline outbox for genuine connectivity failures, real read on both the officer's own portal and the admin's Field analytics tab. **RLS re-scoped 2026-08-19** (`patch-12`): the single "fr own" policy (own-report-or-admin, every operation) split into four — read/update now also recognise "assigned to this school" via the new `school_officer_assignments` table, insert requires assignment (or admin), delete stays own-report-only. |
| **`school_officer_assignments`** | **New 2026-08-19** (`patch-12-school-officer-assignments.sql`). Admin-managed table of which schools each field officer covers — the mechanism behind the tightenings above, not just a display list. Admin UI: `officerAssignmentsPanel()` in the admin dashboard. Consumed by the field officer's own report form (school picker limited to their assignments) and by `assigned_to_school()`, a `SECURITY DEFINER` function used inside the `field_reports`/`school_returns`/`school_return_grades` policies. |
| **`profiles`** | Read (admin user list, "you" badges) and write (admin edits any user's name/email/username/role/project/county/school — including their own role, RLS permits it via `is_admin()`). |
| **`login_events`** | **Fixed 2026-08-19 (commit `302ad5c`).** Was write-only — staff logins/signups inserted via `Repo.record()`, nothing ever selected. Now `Repo.allEvents(user)` merges a real `select` (staff activity) with the local learner/legacy events (which structurally can never be in Postgres, see §7's learner-auth note) into one admin inbox. Guarded to only query when an admin is actually viewing the dashboard — every other role receives the array but never reads it. |
| **Community Resources chat** | Real. A Supabase Edge Function (`community-resources-chat`) backs the assistant; verified working end-to-end against the live deployment. |
| **`classes` / `enrollments`** | **Fixed 2026-08-19 (commit `ebb068d`).** Was zero connection; now real Postgres CRUD for the class shell and roster — create, add/remove learner, all RLS-scoped to `owner_id = auth.uid()`. Deliberately bounded to just these two tables, see below. |
| **`assignments` / `assignment_results` / `assessments` / `questions` / `submissions`** | **Fixed 2026-08-20 (commits `e360426`, `832225e`).** Teacher-authored content (`assignments`, `assessments`, `questions`) writes straight to Postgres now — create, edit, delete, session start/end, and the publish flow that can reassign an assessment to a different class, all RLS-scoped via `owns_class()`. Per-learner data (`assignment_results`, `submissions`) still can't be written by the learner directly — no JWT, same structural fact as everywhere else — so a background `syncResults()` pushes whatever's recorded locally up through the *teacher's* own session, using a `learner_id IS NULL` + `owns_class()` branch the RLS was already built to allow. `hpf_classes` stays the mirror the learner side reads, same hybrid pattern as `classes`/`enrollments`. |

---

## 4. Which Supabase tables already exist

Queried directly against the live project — this is what's actually deployed, not what the SQL files claim:

| Table | RLS | Rows | Client wiring |
|---|---|---|---|
| `profiles` | ✅ | 4 | ✅ read + write |
| `schools` | ✅ | 17 | ✅ read + write |
| `school_returns` | ✅ | 0 | ✅ read + write |
| `school_return_grades` | ✅ | 0 | ✅ read + write |
| `school_return_revisions` | ✅ | 0 | ✅ read-only (audit trail, by design) |
| `field_reports` | ✅ | 0 | ✅ read + write |
| `login_events` | ✅ | 23 | ✅ read + write *(fixed 2026-08-19)* |
| `classes` | ✅ | 0 | ✅ read + write *(fixed 2026-08-19)* |
| `enrollments` | ✅ | 0 | ✅ read + write *(fixed 2026-08-19)* |
| `school_officer_assignments` | ✅ | 0 | ✅ read + write *(new 2026-08-19)* |
| `assignments` | ✅ | 0 | ✅ read + write *(fixed 2026-08-20)* |
| `assignment_results` | ✅ | 0 | ✅ read + write *(fixed 2026-08-20)* |
| `assessments` | ✅ | 0 | ✅ read + write *(fixed 2026-08-20)* |
| `questions` | ✅ | 0 | ✅ read + write *(fixed 2026-08-20)* |
| `submissions` | ✅ | 0 | ✅ read + write *(fixed 2026-08-20)* |

**14 tables total. All 14 have client wiring now** — no table exists in `schema.sql` without a code path that reads or writes it. Every RLS policy from `schema.sql` through `patch-12` is live and matches the committed SQL — no drift found. `classes`/`enrollments` RLS was verified against the live database in rolled-back transactions, not assumed: a second teacher account could not see, rename, or delete another's class, and an insert attempt into someone else's roster was actively rejected (`42501`). `school_officer_assignments` and the tightened `field_reports`/`school_returns` policies were verified the same way (rolled-back transactions impersonating an unassigned officer, an assigned officer, and a school leader from a different school) before `patch-12` was applied. The five coursework tables' RLS was verified the same way before wiring the client to them: a second teacher's read/update/delete against another's assignment/assessment/question came back empty or `42501`, and the `learner_id IS NULL` + `owns_class()` branch `syncResults()` relies on was confirmed to work for the owning teacher and fail for anyone else.

All 14 tables have client wiring; most still show 0 rows because nobody has used the now-connected features in production yet, not because anything is unconnected — `schools` (17) and `login_events` (23) are the two that have organically accumulated real activity so far.

## 4a. The 2026-08-20 schema expansion — deliberately unwired

`patch-13-data-model-expansion.sql` added 21 more tables in one pass, all live, all
RLS-complete, **none with any client wiring yet** — by explicit choice (§0's third
revision), not an oversight this audit is flagging as a gap:

| Table | RLS | Client wiring |
|---|---|---|
| `roles` | ✅ | ❌ none (reference data; `profiles.role` still the enum it always was) |
| `subjects` | ✅ | ❌ none (`assignments.subject_id`/`assessments.subject_id` columns exist, nothing sets them) |
| `learners` | ✅ | ❌ none (`enrollments.learner_id` now points here, nothing populates it — the add-learner UI still writes only `enrollments.name`) |
| `teachers`, `field_officers`, `teacher_training` | ✅ | ❌ none |
| `school_programmes`, `school_facilities` | ✅ | ❌ none |
| `digital_learning`, `kolibri_activity`, `library_activity`, `learning_activity` | ✅ | ❌ none (this is the real table `KOLIBRI.learner`'s fake catalogue could migrate to — see §10) |
| `field_visits`, `field_visit_findings` | ✅ | ❌ none — `field_reports` is still what the field-officer portal actually reads/writes |
| `devices`, `device_maintenance` | ✅ | ❌ none |
| `kobo_submissions` | ✅ | ❌ none, and none planned client-side — meant for a future server-side webhook |
| `interventions`, `action_items` | ✅ | ❌ none — no existing workflow to anchor this against; schema is a best-effort design |
| `notifications` | ✅ | ❌ none — no producer exists yet to write one |
| `audit_logs` | ✅ | ❌ none directly; a callable `log_audit()` helper exists for a future pass to instrument sensitive writes with |

Every RLS policy was verified in rolled-back transactions before this was written, not
assumed: an assigned field officer sees a device at their school and an unrelated
teacher doesn't; a teacher can read/write their own `teachers` row and not another's;
a teacher who owns a class a learner is enrolled in can see that `learners` row and an
unrelated teacher can't; `anon` (no session at all) can read published `digital_learning`
rows, confirming the one deliberate departure from every other table's `to authenticated`
default — content browsing has to work for a learner's JWT-less session eventually, and
there's nothing learner-identifying in a catalogue row.

**Table count is now 35** (14 from §4 + 21 here). This section exists specifically so a
future revision doesn't need to re-discover "is this schema or is this wired" one table
at a time — every row above should flip from ❌ to ✅ with a commit reference the same
way §4's rows did, not silently.

## 5. Which tables are missing

**None, at the schema level — still true, now for every table.** The obvious-sounding
answer ("classes, assignments, submissions need tables") was wrong when this was first
written and stayed wrong through every revision: every table was created back in
`schema.sql`. As of 2026-08-20 all 14 have client code pointed at them (§4) — this
section's job (flagging schema gaps) is now fully closed for the existing schema.

The one genuinely new table this audit ever identified a case for — a content catalogue for the Digital Library — now exists as `digital_learning` (§4a), built 2026-08-20. Nothing on any list this document has produced points at a missing table any more; everything left (§4a, §10) is unwired schema or a product decision, never a schema gap.

## 6. Which dashboard metrics are currently simulated

- Admin: "Users by role" donut, "Logins this week" chart, "Recent activity" feed —
  **fixed 2026-08-20**, all real now (`profiles` for role counts, the merged event set
  for the other two). The top KPI tile row was already real.
- Admin: "Login requests inbox" — fixed 2026-08-19, real merged Postgres+local event set.
- Learner dashboard: still entirely `DASH.learner` + `KOLIBRI.learner` (course progress,
  streak, badges, content catalogue) — the one dashboard surface 2026-08-20's pass
  couldn't touch, since it's blocked on product decisions (§1), not missing schema.
- Teacher dashboard: fully real now. Class list/roster (Postgres since the classes
  migration), assignments/assessments/questions (Postgres since 2026-08-20), and "Class
  activity" (now computed from real local submissions rather than 4 hardcoded names).
  Per-learner results/submissions sync to Postgres in the background via the teacher's
  own session (`syncResults()`) rather than being written by the learner directly.
- Field officer's **own dashboard** (`/dashboard` role view): **fixed 2026-08-20** for
  everything with a real source — assigned schools, visit counts, reports filed, all
  from `school_officer_assignments`/`field_reports`. The old fake "school health" score
  was replaced with a real "last visit per school" fact rather than kept fake. Only the
  task list remains simulated, and it now renders an honest "not yet tracked" state
  (`notTracked()`) instead of 4 hardcoded tasks — there is no task-tracking table.
- School leader dashboard: **fixed 2026-08-20** for enrolled learners / teaching staff /
  attendance rate (from the school's own latest `school_returns` row) and the attendance
  trend (real, reshaped from a fake daily series to a real per-term one, since returns
  are termly). "Performance by grade" and the teacher coaching-ratings table have no
  real source (no per-grade score or rating table exists) and now show `notTracked()`
  rather than fake numbers.

## 7. Which authentication features are simulated

- **Learner accounts**: not simulated so much as *intentionally out-of-model* — a deliberate design choice (learners have no email to register with Supabase Auth against), not a stopgap to migrate away from.
- **Legacy local accounts**: intentionally simulated as a transition bridge for pre-migration users, with the UI honestly labelling sessions as such.
- **Password/username recovery**: code is real, feature is currently **dead in production** for lack of SMTP configuration in the Supabase project (Project Settings → Auth → SMTP). Every `resetPasswordForEmail`/`resend`/OTP call will succeed at the API level and then the email will never arrive. This is an infrastructure task, not a development one.
- **Signup email confirmation**: neutralised on purpose — a database trigger (`patch-11-open-signup.sql`) auto-confirms new accounts, because the same missing-SMTP problem was stranding every new signup unconfirmed and unable to sign in. Documented and deliberate, with the trade-off (unverified email addresses) stated in the migration file itself.

## 8. Which field officer submissions are simulated

**None, as of this session.** Prior to commit `129a781` the entire pipeline was `localStorage`-only (fake "synced"/"pending" status assigned by role, not connectivity). It's now real: live Postgres insert, genuine offline-failure detection, an honest local outbox for connectivity failures specifically (not for permission failures, which are surfaced immediately rather than queued forever), auto-retry on reconnect. Covered in detail in that commit's message.

The field officer's **own `/dashboard` role view** (§6) is now real too, as of 2026-08-20, aside from the task list, which has no real source and honestly says so.

## 9. Which role permissions are currently enforced only in JavaScript

- **The `/field-officer` portal's role gate** (`allowed = role === "field_officer" || role === "admin"`) is still cosmetic, and that's now a smaller gap than it reads. **Fixed 2026-08-19 for the part that matters:** `field_reports`'s insert policy no longer accepts any authenticated user for any school — it now requires `is_admin() or assigned_to_school(school)` (`patch-12`), so a non-officer can no longer file a report for an arbitrary school just by knowing its name. What remains soft: a `teacher`/`school_leader` account that happens to *be* in `school_officer_assignments` (nothing stops an admin from assigning one) could still insert — the check is assignment-based, not role-based, matching this whole schema's ownership pattern (§ intro) rather than checking `profiles.role = 'field_officer'` directly. The UI notice is still a social nudge on top of a now-real assignment check, not the only thing standing between "wrong role" and a successful write.
- **Class/roster ownership — fixed 2026-08-19, no longer JS-only.** A teacher can now only write to a class they own because Postgres RLS says so (`owner_id = auth.uid()`), verified against the live database with a second fake teacher account who could not see, rename, delete, or enroll into another's class. This is a genuine behavior *tightening* worth knowing about: the old JS-only version scoped by school, so any two teachers at the same school used to see each other's classes; RLS scopes by ownership, so that no longer happens.
- **Assignments/assessments/questions role logic — fixed 2026-08-20, no longer JS-only.** Create/edit/delete/publish now go through Postgres RLS (`owns_class()`), verified against the live database the same way the classes migration was: a second teacher's write against another's assignment/assessment/question is rejected, not just hidden by the UI. Per-learner results/submissions are a narrower case: RLS enforces *who can insert on the teacher's behalf* (the owning teacher only), but a submission's *content* (whether the learner actually earned that score) is client-computed and trusted, same as it always was — that's a grading-integrity question, not a permissions gap this migration was ever going to close.
- **Admin-only actions inside the User management panel** (edit any user, delete any user) are enforced only in JS for the **local** `hpf_users` table (there is no RLS on localStorage, definitionally) — the same actions against real Postgres `profiles` **are** RLS-enforced (`is_admin()`), so this one is only a gap for legacy/local accounts, not a general hole.

## 10. What's left — all product decisions now, not data-layer work

Every item this section used to rank by migration cost is done as of 2026-08-20. What
remains has no existing table to connect to and no client code shape to reuse — each
needs an actual product definition before it needs a line of code:

1. **Digital Library.** `LIBRARY_SEED` + `hpf_library` → **schema now exists** (`digital_learning`, §4a, built 2026-08-20) but has zero client wiring — the closest thing left to a pure connect-not-design job, no product decision blocking it any more.
2. **Field officer "school health" score.** Replaced with a real "last visit per school" fact rather than left fake (§6) — but a genuine health *score* (some composite of attendance, dropout rate, visit recency?) still needs a formula decided before it's worth building.
3. **Teacher coaching ratings.** Schema-adjacent now via `teacher_training` (§4a, records completed training, not a rating), but still no table, no UI form, and no definition of who rates whom (teacher self-report? admin observation? field officer during a visit?).
4. **Learner streaks / badges.** Blocked on defining what counts as a "streak" in a real database (login streak, from real `login_events`? lesson-completion streak, from real `submissions`, or the new `learning_activity`, §4a?) — the *data* now exists two ways over; the definition still doesn't.
5. **`KOLIBRI.learner`'s content catalogue.** Schema now exists (`digital_learning`+`kolibri_activity`, §4a) but is unwired *and* still needs the content-sourcing decision this item always needed (curated by HPF? pulled from an external API? user-uploaded like the Digital Library?) — building the table didn't answer that question, just gave it somewhere to live once answered.

---

# Migration plan: CURRENT → TARGET

Every simulated source, matched to the table that should replace it. UI, routes, and role dashboards are unchanged in every row — this is a data-layer swap only, the pattern already proven three times over (`schools`, `school_returns`, `field_reports`).

| # | CURRENT (simulated) | TARGET (Supabase) | New schema needed? | Status |
|---|---|---|---|---|
| 1 | `Repo.events()` → `localStorage["hpf_login_events"]` | `select * from login_events` (staff sessions); keep local recording for learners only | No — table and RLS already live | ✅ **Done** — `302ad5c` |
| 2 | `DASH.admin.roleBreakdown` | `select role, count(*) from profiles group by role` | No | ✅ **Done** — `4983f43` |
| 3 | `DASH.admin.weekly` | `select date_trunc('day', created_at), count(*) from login_events group by 1` | No | ✅ **Done** — `4983f43` |
| 4 | `DASH.admin.activity` | `select * from login_events order by created_at desc limit 5` | No | ✅ **Done** — `4983f43` |
| 5 | `hpf_classes[].{name, school, learners}` | `classes`, `enrollments` | No — tables + RLS already live | ✅ **Done** — `ebb068d` |
| 6 | `hpf_classes[].assignments[]` | `assignments`, `assignment_results` | No | ✅ **Done** — `e360426`, `832225e` |
| 7 | `hpf_classes[].assessments[]` | `assessments`, `questions` | No | ✅ **Done** — `e360426` |
| 8 | `hpf_classes[].assessments[].submissions[]` | `submissions` | No | ✅ **Done** — `832225e` |
| 9 | `hpf_users` (non-learner rows) | `profiles` (already the real store for staff — `hpf_users` should only ever hold learners and legacy accounts going forward) | No | Open — legacy/local accounts still land here by design; see §2 |
| 10 | `DASH.field_officer.*` (own dashboard) | Derived from `field_reports`/`school_officer_assignments` | No | ✅ **Done** — `4983f43`, except the task list (no real source, now `notTracked()`) |
| 11 | `LIBRARY_SEED` + `hpf_library` | New `library_resources` table | **Yes** — genuinely new | Open |
| 12 | `DASH.learner.*`, `KOLIBRI.*` (streaks/badges/coaching ratings) | Undecided pending a product definition of what these numbers mean in a real database | **Yes, but design first** | Open |
| 13 | SMTP-dependent recovery/confirmation flows | No code change — Supabase dashboard configuration (Project Settings → Auth → SMTP) | No | Open |

**Nine of thirteen done.** Everything that was pure "connect existing table to existing
UI" work is now done — rows 2–4 and 6–8 landed 2026-08-20 in three commits (Stage A:
`4983f43`, Stage B: `e360426`, Stage C: `832225e`). What's left is either infrastructure
configuration (13), a genuinely new table with a stable, simple shape (11), or blocked on
a product decision before any code makes sense (9's a soft one — legacy accounts are a
deliberately-tolerated edge case, not an active gap; 12 needs someone to define what a
"streak" or a "coaching rating" actually means before it can become a table).

---

*This document has now tracked three separate rounds of real changes (`patch-12` and the
field-officer permissions work; the `data.js` migration's three commits) rather than
staying audit-only like its first pass — each round's actual detail lives in its own
commit message, not repeated here. Two items remain deliberately open, by explicit
choice, not oversight: **`profiles` read stays open** (`using (true)` — every signed-in
user can read every profile) and **no "Approve" workflow exists anywhere** (skipped by
request). This document is still uncommitted in the working tree; it has now been
produced or revised four times across two days — worth deciding whether it should live
in the repo permanently (root, alongside `SETUP.md`, or under `supabase/`) rather than
sit as a scratch file.*
