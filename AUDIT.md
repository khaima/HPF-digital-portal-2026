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

---

## 0. How the app is put together

| File | Role |
|---|---|
| `config.js` | Supabase project URL + publishable (anon) key. Committed — safe to publish, per its own header comment; access control lives in RLS, not key secrecy. |
| `supabase.js` | Creates the shared `supabase` client (session-persisting) and `adminClient()` (a throwaway client used only so creating a new admin doesn't sign the acting admin out). Exports `authMessage()`, a Postgres/Supabase-error-to-human-text translator used everywhere a write can fail. |
| `data.js` | 21 exported constants — some are genuine static content (nav copy, county lists, form option lists), some are **seed/demo data standing in for a live query** (`DASH`, `LIBRARY_SEED`). This audit only flags the latter as "simulated." |
| `app.js` | Router, `Auth` (sign-up/sign-in for both real Supabase accounts and local-only learners), `Repo` (login/signup event logging), field officer portal, community resources chat, recovery-flow wiring. |
| `dashboards.js` | All five role dashboards (admin/teacher/learner/field_officer/school_leader), the admin analytics/scorecard suite, school-leader termly returns, schools map. 6,694 lines — the bulk of the app. |
| `recovery.js` | Forgot-password / forgot-username flows. Calls real `supabase.auth.*` methods throughout — not a stub, see §7. |
| `supabase/` | 12 SQL files (`schema.sql` + `patch-01` … `patch-12`) plus `SETUP.md`. Confirmed to match the live database exactly (§4) — no drift between what's committed and what's deployed. |

---

## 1. Data currently sourced from `data.js`

Genuinely static (no Supabase table would improve these — they're copy/config, not records):

`PORTAL_CARDS`, `CURRICULUM`, `RESOURCES`, `ASSESSMENT`, `IMPACT`, `EMPOWERMENT_MODEL`,
`ABOUT_POINTS`, `ROLES`, `ORG_TYPES`, `COUNTIES`, `HERO_QUOTES`, `HERO_SLIDES`,
`LIBRARY_CATEGORIES`, `RESOURCE_TYPES`, `REGIONS`/`SCHOOLS` *(fallback only, see §3)*,
`PROJECTS`, `VISIT_TYPES`, `CONTENT_KINDS`, `KOLIBRI` *(teacher-dashboard nav labels)*,
`KPI_TARGETS` *(deliberately-static programme targets, not a measurement)*.

**Note on `REGIONS`:** its Isiolo/Narok lists were edited directly on GitHub outside
this workflow on 2026-08-19, pasted with curly "smart" quotes that are invalid in a JS
string literal — the syntax error broke every page (a parse failure in an imported
module fails the whole graph, not just the affected dropdown). Fixed same-day by
straightening the quotes and closing the array, content otherwise preserved as
authored. Mentioned here only because it demonstrates a real risk specific to this
file: it is plain, uncompiled JS committed directly, so a rich-text paste into GitHub's
web editor can take the entire site down, not just corrupt one field's data.

**Standing in for live data — these are the real gap:**

| Export | What it fakes | Consumed by |
|---|---|---|
| `DASH.admin.roleBreakdown` | Fixed role counts (820 learners, 312 teachers, 84 school leaders, 46 field officers, 22 admins — 1,284 total, never changes) | `adminBody()` → "Users by role" donut, and the "largest group is X%" insight |
| `DASH.admin.weekly` | Fixed 7-value array `[42,61,55,78,66,90,148]` | "Logins this week" bar chart, "busiest day" insight |
| `DASH.admin.activity` | 5 hardcoded named events ("Grace Achieng created a Teacher account"…) | "Recent activity" panel |
| `DASH.admin.stats` | Fixed 4-tile array (1,284 users, 32 schools…) | **Superseded** — `adminKpis()` now computes the top KPI row from `computeAdminStats()` instead. `DASH.admin.stats` is only still read for one derived value (`d.stats` isn't referenced beyond the object literal itself in the current `adminBody`) — effectively dead for that path. |
| `DASH.learner.*` | Course progress, streak, badges | Learner dashboard, in full |
| `DASH.teacher.*` (via `KOLIBRI`) | Class list, student roster stats | Teacher (coach) dashboard, in full |
| `DASH.field_officer.*` | Assigned schools, visit counts, sync counts, school "health" scores, tasks | Field officer's **own dashboard** (`/dashboard`, not `/field-officer`) — separate from the now-real `/field-officer` submission portal, see §3 |
| `DASH.school_leader.*` | Grade performance, attendance trend, teacher ratings | School leader dashboard's *non*-returns widgets (performance-by-grade chart, teacher coaching table) |
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
| `hpf_classes` | **Now a hybrid, not pure localStorage.** Class name/school/roster are fetched from Postgres on mount and mirrored in here; assignments, assessments, questions and submissions are still exclusively local, nested per class, since they have not migrated (§3). Kept deliberately, not a residual gap: (1) it is the only store for the not-yet-migrated coursework data, and (2) learners have no Supabase session at all — RLS is JWT-based and a learner's browser has no JWT to present — so a learner's own view of "my assignments" (`liveSessionsFor`, `learnerAssignments`) can never become a direct client-side Postgres query. That second point is a structural ceiling on how much of `hpf_classes` is removable, not an oversight to fix later. | Teacher coach UI (roster/shell now via Postgres mirror; coursework still direct) |
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
| **`assignments` / `assignment_results` / `assessments` / `questions` / `submissions`** | **Still zero connection.** Five tables exist, live, RLS-enabled, 0 rows (§4). Assignments, assessments, quiz questions and submissions still live nested inside each class object in `hpf_classes` — deliberately out of scope for the classes/enrollments migration (mixing them in would have meant touching far more than "classes"), and still true that no client request ever reaches these five tables. |

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
| `assignments` | ✅ | 0 | ❌ none |
| `assignment_results` | ✅ | 0 | ❌ none |
| `assessments` | ✅ | 0 | ❌ none |
| `questions` | ✅ | 0 | ❌ none |
| `submissions` | ✅ | 0 | ❌ none |

**14 tables total.** Every RLS policy from `schema.sql` through `patch-12` is live and matches the committed SQL — no drift found. `classes`/`enrollments` RLS was verified against the live database in rolled-back transactions, not assumed: a second teacher account could not see, rename, or delete another's class, and an insert attempt into someone else's roster was actively rejected (`42501`). `school_officer_assignments` and the tightened `field_reports`/`school_returns` policies were verified the same way (rolled-back transactions impersonating an unassigned officer, an assigned officer, and a school leader from a different school) before `patch-12` was applied.

Nine tables still at 0 rows is expected, not a red flag — `schools` (17) and `login_events` (23) are the two that have organically accumulated real activity so far; the rest are correctly empty because either no one has used the now-connected features yet (`classes`, `enrollments`, `field_reports`, `school_returns`) or the client genuinely never writes to them yet (the five remaining coursework tables).

## 5. Which tables are missing

**None, at the schema level — still true.** The obvious-sounding answer ("classes, assignments, submissions need tables") was wrong when this was first written and remains wrong: every table was created back in `schema.sql`. What's changed is that two of the previously-unconnected tables (`classes`, `enrollments`) now have client code pointed at them; the remaining five coursework tables (`assignments`, `assignment_results`, `assessments`, `questions`, `submissions`) are still in the same state — fully-formed, RLS-complete, nothing reading or writing them.

The one genuinely new table this audit has ever identified a case for is `library_resources`, for the Digital Library (§10) — everything else on the list is connect-not-create.

## 6. Which dashboard metrics are currently simulated

- Admin: "Users by role" donut, "Logins this week" chart, "Recent activity" feed, the associated smart-insights (busiest day, largest role share) — all still `DASH.admin` (§1), **unchanged by the login_events fix**: that fix connected the inbox specifically, not these three widgets, which is exactly what migration-table row 2–4 still describes. The top KPI tile row is **not** simulated (computed live).
- Admin: "Login requests inbox" — **fixed 2026-08-19**, now reads the real merged Postgres+local event set (§3), no longer localStorage-only.
- Learner dashboard: entirely `DASH.learner` + `KOLIBRI` (course progress, streak, badges) — unaffected by the classes migration, since the migration only touched the class shell/roster, not coursework. Still matches the localStorage-only coursework model, still not Postgres-backed.
- Teacher dashboard: class list and roster now genuinely Postgres-backed (real cross-device data, real per-teacher ownership via RLS — a real tightening from before, when any teacher at the same school saw every class there). Assignments/assessments/results within a class remain local, unchanged.
- Field officer's **own dashboard** (`/dashboard` role view): `DASH.field_officer` — assigned-schools count, visit counts, "school health" scores, task list. Distinct from the `/field-officer` submission portal, which is real (§3) — the two surfaces currently disagree, since one is fake and one is live.
- School leader dashboard: the termly-returns panel is real (§3); the "Performance by grade" chart and "Teaching staff" coaching-rating table on the same page are `DASH.school_leader`, fake.

## 7. Which authentication features are simulated

- **Learner accounts**: not simulated so much as *intentionally out-of-model* — a deliberate design choice (learners have no email to register with Supabase Auth against), not a stopgap to migrate away from.
- **Legacy local accounts**: intentionally simulated as a transition bridge for pre-migration users, with the UI honestly labelling sessions as such.
- **Password/username recovery**: code is real, feature is currently **dead in production** for lack of SMTP configuration in the Supabase project (Project Settings → Auth → SMTP). Every `resetPasswordForEmail`/`resend`/OTP call will succeed at the API level and then the email will never arrive. This is an infrastructure task, not a development one.
- **Signup email confirmation**: neutralised on purpose — a database trigger (`patch-11-open-signup.sql`) auto-confirms new accounts, because the same missing-SMTP problem was stranding every new signup unconfirmed and unable to sign in. Documented and deliberate, with the trade-off (unverified email addresses) stated in the migration file itself.

## 8. Which field officer submissions are simulated

**None, as of this session.** Prior to commit `129a781` the entire pipeline was `localStorage`-only (fake "synced"/"pending" status assigned by role, not connectivity). It's now real: live Postgres insert, genuine offline-failure detection, an honest local outbox for connectivity failures specifically (not for permission failures, which are surfaced immediately rather than queued forever), auto-retry on reconnect. Covered in detail in that commit's message.

The one remaining simulated field-officer-adjacent surface is the field officer's **own `/dashboard` role view** (§6), which is unrelated to report submission — it's the KPI/task-list view, still `DASH.field_officer`.

## 9. Which role permissions are currently enforced only in JavaScript

- **The `/field-officer` portal's role gate** (`allowed = role === "field_officer" || role === "admin"`) is still cosmetic, and that's now a smaller gap than it reads. **Fixed 2026-08-19 for the part that matters:** `field_reports`'s insert policy no longer accepts any authenticated user for any school — it now requires `is_admin() or assigned_to_school(school)` (`patch-12`), so a non-officer can no longer file a report for an arbitrary school just by knowing its name. What remains soft: a `teacher`/`school_leader` account that happens to *be* in `school_officer_assignments` (nothing stops an admin from assigning one) could still insert — the check is assignment-based, not role-based, matching this whole schema's ownership pattern (§ intro) rather than checking `profiles.role = 'field_officer'` directly. The UI notice is still a social nudge on top of a now-real assignment check, not the only thing standing between "wrong role" and a successful write.
- **Class/roster ownership — fixed 2026-08-19, no longer JS-only.** A teacher can now only write to a class they own because Postgres RLS says so (`owner_id = auth.uid()`), verified against the live database with a second fake teacher account who could not see, rename, delete, or enroll into another's class. This is a genuine behavior *tightening* worth knowing about: the old JS-only version scoped by school, so any two teachers at the same school used to see each other's classes; RLS scopes by ownership, so that no longer happens.
- **Assignments/assessments/questions/submissions role logic** (who can publish, who can see results, who can submit) is still enforced **only** in `dashboards.js` against `hpf_classes` in localStorage — unaffected by the classes/enrollments migration, which deliberately did not extend to these four tables. Their RLS policies are fully written and live (§4) but still enforce nothing in practice, because no client request reaches them yet.
- **Admin-only actions inside the User management panel** (edit any user, delete any user) are enforced only in JS for the **local** `hpf_users` table (there is no RLS on localStorage, definitionally) — the same actions against real Postgres `profiles` **are** RLS-enforced (`is_admin()`), so this one is only a gap for legacy/local accounts, not a general hole.

## 10. Features connectable to Postgres without a UI rewrite

Ranked by how directly the existing UI's data shape already matches a Postgres row — i.e., cheapest first, based on how all five migrations to date (`schools`, `school_returns`, `field_reports`, `login_events`, `classes`+`enrollments`) actually went. The two cheapest items from the original ranking are done; what's left:

1. **`assignments` / `assignment_results`.** Nested under each class in the current model, same fields as the Postgres columns (`title`, `type`, `due`, `session`) — now the natural next step, since the class each assignment belongs to is real. One real complication the `classes` migration surfaced concretely: any *learner-facing* read of "my assignments" cannot become a direct Postgres query, because learners have no Supabase session and RLS has no JWT to check (see §2's `hpf_classes` note). Migrating these two tables would move the *teacher's* authoring side to Postgres; a learner's own view would still need to read a local mirror, same pattern `classes`/`enrollments` already established.
2. **`assessments` / `questions` / `submissions`.** More surface area (three tables, and quiz-taking has more client-side state — timers, current-question position — that should stay client-only) but no new UI concepts; the RLS is already written. Same learner-read ceiling as above applies to submissions specifically, since a learner is the one submitting.
3. **Admin's `DASH.admin.roleBreakdown`/`.weekly`/`.activity`.** No new table needed — `roleBreakdown` is a `GROUP BY role` over `profiles` (already live), `.weekly` and `.activity` are queries over `login_events` (its read side is now live, so nothing blocks this). Pure query work, zero new schema, and the cheapest remaining item on this list now that its prerequisite is done.
4. **Digital Library.** `LIBRARY_SEED` + `hpf_library` → a new `library_resources` table would be genuinely new schema (not in `schema.sql` today), but the UI's resource shape (`title, category, type, url, description, published`) is simple and already stable.
5. **Field officer's own `/dashboard` view (`DASH.field_officer`).** Once #1–#2 land, this becomes a derived view over already-migrated tables (visit counts from `field_reports`, which is already real; task list would need its own small table or could be dropped in favor of the real data it's currently faking).
6. **Learner/teacher dashboards' remaining `DASH`/`KOLIBRI` figures** (streaks, badges, coaching ratings) are the least Postgres-shaped of everything above — they'd need real design decisions (what counts as a "streak"? is a coaching rating a teacher self-report or an admin observation?) before a table makes sense, not just a data-layer swap.

---

# Migration plan: CURRENT → TARGET

Every simulated source, matched to the table that should replace it. UI, routes, and role dashboards are unchanged in every row — this is a data-layer swap only, the pattern already proven three times over (`schools`, `school_returns`, `field_reports`).

| # | CURRENT (simulated) | TARGET (Supabase) | New schema needed? | Status |
|---|---|---|---|---|
| 1 | `Repo.events()` → `localStorage["hpf_login_events"]` | `select * from login_events` (staff sessions); keep local recording for learners only | No — table and RLS already live | ✅ **Done** — `302ad5c` |
| 2 | `DASH.admin.roleBreakdown` | `select role, count(*) from profiles group by role` | No | Open |
| 3 | `DASH.admin.weekly` | `select date_trunc('day', created_at), count(*) from login_events group by 1` | No | Open |
| 4 | `DASH.admin.activity` | `select * from login_events order by created_at desc limit 5` | No | Open |
| 5 | `hpf_classes[].{name, school, learners}` | `classes`, `enrollments` | No — tables + RLS already live | ✅ **Done** — `ebb068d` |
| 6 | `hpf_classes[].assignments[]` | `assignments`, `assignment_results` | No | Open |
| 7 | `hpf_classes[].assessments[]` | `assessments`, `questions` | No | Open |
| 8 | `hpf_classes[].assessments[].submissions[]` | `submissions` | No | Open |
| 9 | `hpf_users` (non-learner rows) | `profiles` (already the real store for staff — `hpf_users` should only ever hold learners and legacy accounts going forward) | No | Open |
| 10 | `DASH.field_officer.*` (own dashboard) | Derived from `field_reports` (already real) once #6–#8 give it real visit/school context | No | Open |
| 11 | `LIBRARY_SEED` + `hpf_library` | New `library_resources` table | **Yes** — genuinely new | Open |
| 12 | `DASH.learner.*`, `KOLIBRI.*` (streaks/badges/coaching ratings) | Undecided pending a product definition of what these numbers mean in a real database | **Yes, but design first** | Open |
| 13 | SMTP-dependent recovery/confirmation flows | No code change — Supabase dashboard configuration (Project Settings → Auth → SMTP) | No | Open |

**Two of thirteen done.** Remaining suggested order, matching risk/effort to value: **2–4 → 6–8 → 9 → 10 → 13 → 11 → 12.** Rows 2–4 and 9 are pure "connect existing table to existing UI," the exact work already done five times now; the last two need product decisions before they need code. Row 6 onward inherits the structural note from §10: the *teacher-authoring* side can move to Postgres the same way `classes` did, but any *learner-facing* read stays on a local mirror, since learners have no JWT for RLS to check.

---

*This revision documents real application/schema changes (`patch-12`,
`officerAssignmentsPanel()`, the field officer school picker) rather than being audit-only
like the first two passes — those changes are covered in full in this session's commit,
not repeated here. Two items surfaced by the "real authentication" request were
deliberately left open, by explicit choice, not oversight: **`profiles` read stays open**
(every signed-in user can read every profile — flagged, not acted on,
since no one asked for it to change — flagged as `using (true)`) and **no "Approve" workflow exists anywhere**
(the requester chose to skip it for now). This document is still uncommitted in the
working tree; it has now been produced or revised three times — this is a good point to
decide whether it should live in the repo permanently (root, alongside `SETUP.md`, or
under `supabase/`) rather than sit as a scratch file.*
