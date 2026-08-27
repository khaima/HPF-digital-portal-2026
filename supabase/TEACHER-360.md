# Teacher 360

A unified, read-only profile for one teacher — 8 tabs over data that
already exists in Postgres. Opened from Master Data Management → Teachers
(the layers icon on any teacher row). Nothing here is a new table or a
second copy of a teacher record: every tab queries the same rows every
other panel in this app already reads, scoped to one teacher's
`profiles.id`.

Built as the second implementation of the entity-profile pattern
[`SCHOOL-360.md`](SCHOOL-360.md) established first — the shared helpers
(`x360Gate`, `x360Section`, `x360EmptyRow`, `x360MetricCard`, `x360Period`,
`x360MaxDate`) were generalized from School 360's original `s360*` names
specifically so Teacher 360 could reuse them rather than duplicating
near-identical rendering code. Any future "360" view (Field Officer, School
Leader) should extend the same shared helpers rather than starting over.

## Tabs

Overview, Training, Lesson Planning, ICT Adoption, Digital Resources,
Assignments, Assessments, Follow-up.

| Tab | Reads |
|---|---|
| Training | `teacher_training` |
| Lesson Planning | `assignments` where `type = 'lesson'`, scoped through this teacher's classes |
| ICT Adoption | `kolibri_activity` + `library_activity` + `learning_activity` for learners enrolled in this teacher's classes — a labeled **proxy**, not a direct measurement, see below |
| Digital Resources | same three activity tables as ICT Adoption, presented as a resource-usage breakdown rather than an adoption trend |
| Assignments | `assignments` where `type <> 'lesson'` (i.e. `exercise`/`quiz`), scoped through this teacher's classes |
| Assessments | `assessments` + `submissions`, scoped through this teacher's classes |
| Follow-up | `field_reports` mentioning this teacher's classes/school, and open `interventions`/`action_items` linked to this teacher — "what still needs attention," not a new workflow |

**Why "Lesson Planning" and "Assignments" don't overlap.** Both tabs read
`assignments`, split by the existing `work_type` enum on `assignments.type`
(`lesson` / `exercise` / `quiz`) rather than inventing a new column or
duplicating rows into two tables. A lesson plan and a graded exercise are
the same underlying table because a teacher already creates both through
the same class-content flow — this view just separates them the way the
request asked for, without changing what's stored.

**Why "ICT Adoption" is explicitly labeled a proxy.** There is no table
that records a teacher's own technology use. What exists is Kolibri/library/
learning activity logged by *learners* — so the metric shown is "digital
learning events among learners enrolled in this teacher's classes," and the
UI says exactly that rather than presenting it as if it measured the
teacher directly. This follows the same standing rule `SCHOOL-360.md`'s
"digital learning activity" metric and the RBAC pass's audit-log work both
already apply: never state more precision or directness than a derived
number actually has.

**Why read-only.** Every one of these tables already has a place to
create, edit, or archive its rows — Master Data Management for the teacher
record itself, the class/assignment/assessment authoring flows in the
teacher's own dashboard for the rest. This view exists to answer "what does
this teacher's practice look like right now," not to duplicate the tools
that change it.

**Why nothing is cached across visits.** Closing the panel discards its
state. Reopening a teacher re-reads the database.

## The Overview metrics

Every metric carries all four of: current value, reporting period, last
updated, and data source — not just a number.

| Metric | Value | Period | Source |
|---|---|---|---|
| Classes taught | Count of active classes | "Current" | `classes` |
| Learners reached | Distinct enrolled learners across this teacher's classes | "Current roster" | `enrollments` |
| Training completed | Trained / total training records | "All-time" | `teacher_training` |
| Certificates | Count of training records with a certificate on file | "All-time" | `teacher_training` |
| Lessons planned | Count of `assignments` where `type = 'lesson'` | the observed date range of what's returned | `assignments` |
| Assignments set | Count of `assignments` where `type <> 'lesson'` | the observed date range of what's returned | `assignments` |
| ICT adoption (proxy) | Digital-learning event count among this teacher's learners | the observed date range of what's returned | `kolibri_activity` / `library_activity` / `learning_activity` |
| Assessments given | Count of `assessments` linked to this teacher's classes | "All-time" | `assessments` |

**On "reporting period" for activity data**: same rule as School 360 — the
lesson/assignment/ICT-adoption queries have no server-side date filter,
so the period shown is the true min–max date actually present in what came
back, computed from the data, never a claimed window the query doesn't
enforce.

**Eight independent metrics, eight independent empty states.** A teacher
with no `teacher_training` rows shows "No data yet" for training
specifically while every other metric renders normally.

## Loading

Four sequential phases (`Promise.all` per phase, not one flat batch),
because later queries need IDs the earlier ones return: teacher profile →
this teacher's classes → learners enrolled in those classes + assignments
+ assessments tied to those classes → activity/submission rows filtered
against the learner and assessment IDs from the previous phase. The same
shape School 360's loader already uses for the same reason.

## States

- **Loading**: the moment a teacher is opened, before its first query
  resolves.
- **Error**: a load failure shows what broke and a Retry button that
  re-runs the whole load. The top-level "the teacher record itself failed
  to load" path also has a retry button — see **Bugs found and fixed**
  below.
- **Empty**: every tab and every Overview metric states plainly when a
  table has nothing for this teacher, with a specific noun, never a bare
  "No data."

## Bugs found and fixed while building this

**Missing retry button on total load failure — found in both Teacher 360
and already-live School 360.** `x360Gate()` (the per-tab loading/error/
empty renderer) always included a Retry button on error. But the modal's
*top-level* error path — when the initial entity lookup itself fails,
before any tab can render at all — had been written as a bare error
message with no way to recover except closing and reopening the whole
panel. Confirmed live by forcing the initial `profiles` lookup to return a
500: the modal rendered "Could not load this teacher" with no button.
Fixed in both `school360Modal()` and `teacher360Modal()` by adding the same
`data-s360-retry` / `data-t360-retry` button the per-tab error state
already had. Re-verified end-to-end: forced failure → retry click →
successful load.

## Authorization

No new RLS — every query already runs through the has_perm()-plus-row-scope
policies from the RBAC pass (`AUTH-RBAC.md`), scoped to `people`,
`coursework`, `field_ops`, `interventions`, exactly as everywhere else. An
authorized user who can't see a given table's rows for this teacher gets
that tab's ordinary empty state, not an error — RLS returning zero rows and
a table genuinely having zero rows are indistinguishable from the client.

## Responsiveness

Same modal shell, metric grid, and tab bar as School 360 (`max-width:1180px;
max-height:92vh`, `repeat(auto-fill, minmax(240px,1fr))` grid,
`overflow-x:auto` tab bar) — no new CSS written for this feature. Verified
at 768×1024 (tablet): no horizontal page overflow, grid collapses to 2
columns, tab bar scrolls rather than wraps.
