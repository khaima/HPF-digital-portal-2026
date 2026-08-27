# HPF Digital Portal — schema reference

What the database actually looks like, as of `patch-27`. This is a
reference, not a narrative — for the story of how it got here, see
`AUDIT.md`; for run order, see `SETUP.md`; for the full role/permission
design and its live-tested verification, see **`AUTH-RBAC.md`**; for the
Master Data Management screens (Schools, Teachers, Learners, School
Leaders, Devices, Infrastructure) built on top of this schema, see
**`MDM.md`**. 42 tables
(40 domain tables + `app_modules`/`permissions`, the permission matrix
itself), every one RLS-enabled, built from the same small vocabulary of
`SECURITY DEFINER` helper functions rather than one-off authorization logic
per table: `is_admin()`, `is_staff()`, `is_programme_manager()`,
`has_perm()`, `owns_class()`, `enrolled_in()`, `teaches_learner()`,
`assigned_to_school()`, `visit_school_match()`, `activity_visible()`.

Every RLS policy (158 of them) is built from two independent halves —
`has_perm(module, action)` (may this *role* do this *kind* of thing) and a
row-scope expression (to *this* row) — rather than one combined check. See
`AUTH-RBAC.md` for why both are necessary and how that was verified against
the live database, not just written.

Every table below has a UUID primary key. `created_at` + `updated_at` (the
latter kept honest by the shared `touch_updated_at()` trigger) are called
out per table; append-only event/log tables intentionally have only one
timestamp, since nothing ever updates those rows.

## People

| Table | Purpose | Key FKs | Timestamps |
|---|---|---|---|
| `profiles` | One row per real account (every role incl. staff/admin). `school_id` (patch-26) is a real FK for Teachers/School Leaders/Field Officers, kept in sync with the older free-text `school` column rather than replacing it — see `MDM.md`. `active` (patch-26) is an MDM roster flag, not an access-control one. | `id` → `auth.users`, `school_id` → `schools` | created + updated |
| `roles` | Label/description lookup for `profiles.role` | `profiles.role` → `roles.id` | — (fixed reference data) |
| `teachers` | 1:1 extension of a teacher's `profiles` row. `tsc_number` (patch-26) is unique — a real national identifier, not a fuzzy-match guess. | `id` → `profiles` | created + updated |
| `field_officers` | 1:1 extension of a field officer's `profiles` row | `id` → `profiles` | created + updated |
| `teacher_training` | Training records for a teacher | `teacher_id` → `profiles` | created + updated |
| `learners` | Roster identity — no auth account, ever (see below). `grade` and `active` added in patch-26; `admission_number` is unique per school. | `school_id` → `schools`, `created_by` → `profiles` | created + updated |

**School leaders have no extension table.** Unlike teachers/field officers,
a school leader has no role-specific fields beyond what `profiles` already
carries (`head_title`, `phone`, added directly to `profiles` by `patch-10`)
— a separate table would hold nothing a teacher's `teachers` row does.

**Learners structurally cannot hold a Supabase Auth account.** RLS is
JWT-based; a learner has no email to register with, so `learners` has no
`auth.users` counterpart and never will under this model. Their
localStorage-backed session (`hpf_users`/`hpf_session`) is a separate,
client-side concern this table doesn't touch.

## Schools

| Table | Purpose | Key FKs | Timestamps |
|---|---|---|---|
| `schools` | The school itself — name, county, GPS, story, plus (patch-26) code, sub-county, location, programme status, contact info, and `active` | — | created + updated |
| `school_facilities` | Current-state infrastructure inventory (1 row per school) | `school_id` → `schools` | updated only (no separate created_at — the row is created once with its first state) |
| `school_programmes` | Which HPF programmes run at a school, and their status | `school_id` → `schools` | created + updated |
| `school_returns` | Termly self-reported figures (enrolment, staffing, facilities) | `submitted_by` → `profiles` | created + updated |
| `school_return_grades` | Enrolment split by grade/gender, one return's breakdown | `return_id` → `school_returns` | — (kept in sync by `sync_return_enrolment()`, no independent edits) |
| `school_return_revisions` | Audit trail of corrections to a filed return | `return_id` → `school_returns`, `corrected_by` → `profiles` | `corrected_at` only — an immutable log entry |
| `school_officer_assignments` | Which field officer covers which school | `officer_id` → `profiles` | created only |

## Classes and coursework (wired, in active use)

| Table | Purpose | Key FKs |
|---|---|---|
| `classes` | A teacher's class/roster shell | `owner_id` → `profiles` |
| `enrollments` | A learner's membership in a class | `class_id` → `classes`, `learner_id` → `learners` |
| `subjects` | Curriculum subject list | — |
| `assignments` | Lessons/exercises/quizzes a teacher sets | `class_id` → `classes`, `subject_id` → `subjects` |
| `assignment_results` | A learner's result on an assignment | `assignment_id` → `assignments`, `enrollment_id` → `enrollments` |
| `assessments` | Auto-marked MCQ assessments | `class_id` → `classes`, `subject_id` → `subjects` |
| `questions` | One question on an assessment | `assessment_id` → `assessments` |
| `submissions` | A learner's assessment attempt | `assessment_id` → `assessments`, `learner_id` → `learners` |
| `attendance_records` **(new, patch-18)** | One row per learner per class per day | `learner_id` → `learners`, `class_id` → `classes`, `recorded_by` → `profiles` |

`attendance_records` is schema-only so far — nothing reads it yet, and
`school_returns.attendance_rate` keeps working exactly as it does today. A
future pass could compute the aggregate from real rows here instead of a
typed-in percentage; building that pass is a separate, later decision.

## Field operations

| Table | Purpose | Key FKs |
|---|---|---|
| `field_reports` | The field officer portal's live table (what's actually used today) | `user_id` → `profiles` |
| `field_visits` | Future-shaped, normalized version of the same concept | `officer_id` → `profiles`, `school_id` → `schools` |
| `field_visit_findings` | A finding logged against a visit | `visit_id` → `field_visits` |

Both `field_reports` and `field_visits` exist deliberately — `field_reports`
is what the portal actually reads and writes today; `field_visits` is the
schema patch-13 built for a future migration that hasn't happened yet.

## Assets

| Table | Purpose | Key FKs |
|---|---|---|
| `devices` | A physical device at a school. `serial_number` and `asset_tag` (patch-26) are both unique. | `school_id` → `schools` |
| `device_maintenance` | An issue reported against a device | `device_id` → `devices`, `reported_by` → `profiles` |

## Digital learning

| Table | Purpose | Key FKs |
|---|---|---|
| `digital_learning` | Content catalogue (videos, exercises, readings…) | `subject_id` → `subjects`, `created_by` → `profiles` |
| `kolibri_activity` | Usage ingested from an external Kolibri deployment | `content_id` → `digital_learning`, `learner_id` → `learners` |
| `library_activity` | Usage against HPF's own curated catalogue | `content_id` → `digital_learning`, `learner_id` → `learners` |
| `learning_activity` | General, not-content-specific engagement timeline | `learner_id` → `learners`, plus a polymorphic `ref_table`/`ref_id` |

None of the four are wired to any UI yet — `hpf_library` (localStorage) is
still what the actual Digital Library panel reads and writes today.

## Case management

| Table | Purpose | Key FKs |
|---|---|---|
| `interventions` | An open case against a school | `school_id` → `schools`, `opened_by` → `profiles` |
| `action_items` | A task under an intervention | `intervention_id` → `interventions`, `assignee_id` → `profiles` |

## Monitoring & evaluation **(new, patch-19)**

| Table | Purpose | Key FKs |
|---|---|---|
| `me_indicators` | What is measured — a fixed, staff-managed vocabulary | — |
| `me_indicator_values` | An actual measurement for a period, tagged with its source | `indicator_id` → `me_indicators`, `school_id` → `schools` (null = org-wide), `recorded_by` → `profiles` |
| `me_targets` | What the value should be | `indicator_id` → `me_indicators`, `school_id` → `schools` (null = org-wide), `set_by` → `profiles` |

Three tables, not one wide one, because they answer different questions:
indicators define *what*, values record *what happened* (with provenance —
`source` is `computed`/`manual`/`kobo_submission`, never pretending every
number came from the same place), targets record *what should happen*. A
value is never derived by copying a target, and a target is never inferred
from a value — keeping them apart is what makes "did we hit the target"
a query (`value >= target_value`) instead of a fact someone has to remember
to keep in sync by hand. `data.js`'s `KPI_TARGETS` constant is untouched;
this table is what a future pass would read from instead.

## Evidence **(new, patch-20)**

| Table | Purpose | Key FKs |
|---|---|---|
| `evidence` | Generic supporting attachment, linked to any other row | `ref_table`/`ref_id` (polymorphic, same pattern as `learning_activity`), `uploaded_by` → `profiles` |

## Platform

| Table | Purpose | Key FKs |
|---|---|---|
| `login_events` | Signup/login audit trail for real (Supabase) accounts | — |
| `notifications` | A message for one recipient | `recipient_id` → `profiles` |
| `audit_logs` | Generic sensitive-action trail, written via `log_audit()` | `actor_id` → `profiles` |
| `kobo_submissions` | Raw sink for a future KoboToolbox webhook — no client insert path | — |

`login_events`, `notifications`, `audit_logs`, and the three digital-learning
activity tables are append-only by design — no `updated_at`, since nothing
ever updates a row after it's written.

## Relationship map (the load-bearing FK chains)

```
auth.users ─┬─ profiles ─┬─ teachers ── teacher_training
            │            ├─ field_officers
            │            └─ (role: admin/staff/teacher/field_officer/school_leader)
            │
schools ─┬─ school_facilities
         ├─ school_programmes
         ├─ school_returns ─┬─ school_return_grades
         │                  └─ school_return_revisions
         ├─ school_officer_assignments (→ profiles)
         ├─ devices ── device_maintenance
         ├─ field_visits ── field_visit_findings
         ├─ interventions ── action_items
         └─ learners ─┬─ enrollments ── classes (→ profiles, owner)
                       ├─ submissions / assignment_results
                       ├─ attendance_records ── classes
                       ├─ kolibri_activity / library_activity / learning_activity
                       └─ (school leader's own school = profiles.school, matched by name)

me_indicators ─┬─ me_indicator_values (→ schools, nullable)
               └─ me_targets (→ schools, nullable)

evidence ── (ref_table, ref_id) ──▶ any of the above, informally
```

The one non-obvious join in this schema: a school leader's scope is matched
by **name** (`profiles.school = schools.name`), not by a foreign key —
`profiles.school` is a free-text field carried over from signup, not a
`school_id`. Every policy that scopes a school leader to "their own school"
(`school_returns`, `school_facilities`, `learners`, `me_indicator_values`,
and others) does this same name-match rather than a direct FK, which is why
renaming a school in the `schools` table without updating every affected
profile would silently break that scoping — worth knowing before ever
editing a school's name in production.

## What's wired to the UI today, and what isn't

Real client code reads and writes: `profiles`, `schools`, `school_returns`
+ grades + revisions, `field_reports`, `login_events`, `classes`,
`enrollments`, `school_officer_assignments`, `assignments`,
`assignment_results`, `assessments`, `questions`, `submissions`,
`device_maintenance`, `learners`, `attendance_records`, `me_indicators`,
`me_indicator_values`, `me_targets`, `school_facilities`,
`school_programmes`, `devices`, `teachers`, `field_officers`,
`interventions`, `action_items`, `evidence`, and `digital_learning` — 30
tables.

The remaining 11 — `roles`, `teacher_training`, `subjects`, `field_visits` +
`field_visit_findings`, `kolibri_activity`, `library_activity`,
`learning_activity`, `notifications`, `audit_logs`, `kobo_submissions` —
are real, RLS-complete schema with zero client wiring.
`school_returns.attendance_rate` also still stands alone; nothing yet
computes it from the now-real `attendance_records` rows. Building UI
against any of these is a separate, future decision.

## What the browser still stores, and why

Not everything belongs in Postgres, and a few things structurally cannot be
there — a learner has no email, so no Supabase Auth account, so no JWT, and
every RLS policy is granted `to authenticated`. Which browser-held data is
deliberate (session state, caches, the offline queue) and which was a bug
that has since been migrated is audited in full, key by key, in
[`STORAGE-AUDIT.md`](STORAGE-AUDIT.md).

## Changes from patch-21

`login_events` gains `source` (`supabase` | `local`) and the
`record_local_login()` SECURITY DEFINER function — the narrow, anon-callable
path that lets a learner's sign-in be recorded at all. `digital_learning`
gains `file_name` + `updated_at` and is now the Digital Library's only home.
`me_indicators` gains `scorecard_pillar`, a nullable, finer-grained pillar
for the admin Scorecard's own four programme pillars, kept separate from the
coarse M&E `pillar` vocabulary rather than collapsed into it.
