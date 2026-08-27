# Learner 360

A unified, read-only profile for one learner — 5 tabs over data that
already exists in Postgres. Opened from Master Data Management → Learners
(the layers icon on any learner row). Nothing here is a new table or a
second copy of a learner record.

Built as the third implementation of the entity-profile pattern
[`SCHOOL-360.md`](SCHOOL-360.md) and [`TEACHER-360.md`](TEACHER-360.md)
established — same shared `x360*` rendering helpers, same load → cache →
gate → render shell. What's new here is the **Progress** tab: the first
"360" tab that doesn't just list activity, it states a computed trend.

## The identity gap this view has to work around

`learners` (patch-13/MDM — what this view is keyed on, and what Attendance
and Digital Engagement read from directly) and the class-roster/assessment
system (`enrollments`, `assessments`, `submissions`) are **two ID spaces
that were never connected**:

- `attendance_records.learner_id`, `kolibri_activity.learner_id`,
  `library_activity.learner_id`, and `learning_activity.learner_id` all
  reference `learners(id)` — a real foreign key. Attendance and Digital
  Engagement below are exact, direct joins.
- `enrollments.learner_id` and `submissions.learner_id` both reference
  `profiles(id)` instead, and are hard-coded `null` on every insert this
  app makes today — confirmed by reading both write paths: the
  `#addLearnerForm` submit handler's own comment says local learner
  accounts "have no matching row in profiles... there is no id
  enrollments.learner_id could validly reference," and the quiz-sync code
  inserts every `submissions` row with `learner_id: null`. A roster
  entry's only real identity is its typed `name` field.

So Assessments can't be reached by id at all. The Assessments tab instead
matches `enrollments.name` / `submissions.name` against this learner's own
`full_name`, scoped to classes at their own school (`classes.school =
schools.name` — the same name-based bridge School 360 already uses for
`classes`/`field_reports`, a documented pre-existing limitation, see
`SCHEMA.md`). This is a best-effort match, not a guaranteed identity link,
and the tab says so in the UI rather than presenting borrowed precision.

## Tabs

Overview, Attendance, Digital Engagement, Assessments, Progress — the
literal pipeline this feature was requested as.

| Tab | Reads |
|---|---|
| Attendance | `attendance_records`, direct `learner_id` join |
| Digital Engagement | `kolibri_activity` + `library_activity` + `learning_activity`, direct `learner_id` join, merged and sorted |
| Assessments | `assessments` + `submissions`, name-matched through this learner's school's classes (see above) |
| Progress | Computed from the same attendance and submission rows — no new data, no new table |

**Digital Engagement here is a direct measurement, not a proxy** — unlike
Teacher 360's "ICT adoption" (which has to infer a teacher's practice from
their classroom's aggregate learner activity, since no table tracks a
teacher's own tech use), this learner's own `learner_id` genuinely appears
on every kolibri/library/learning-activity row being read.

## The Overview metrics

| Metric | Value | Period | Source |
|---|---|---|---|
| Attendance rate | % present, all recorded sessions | observed date range | `attendance_records` |
| Digital engagement | Event count | observed date range | `kolibri_activity` / `library_activity` / `learning_activity` |
| Assessments taken | Count + average score | observed date range | `submissions` (name-matched) |
| Attendance trend | Improving / Declining / Stable, previous month → latest month | "Month over month" | computed from `attendance_records` |
| Assessment score trend | Improving / Declining / Stable, previous month → latest month | "Month over month" | computed from `submissions` |

Five independent metrics, five independent empty states — a learner with
no submissions yet shows "No data yet" for both assessment metrics while
attendance and digital engagement render normally if present.

## Progress: outcomes, not just activity counts

HPF's own published impact work tracks attendance and dropout as outcome
indicators, not activity counts — this tab is the one place in the "360"
family that turns raw history into a stated direction rather than a list.

**What it computes**: attendance rows are bucketed by calendar month and
reduced to a % present per month; submissions are bucketed the same way
and reduced to an average `pct` per month. The trend line compares only
the two most recent months that actually have data — "50% → 100%,
Improving" is a plain, real fact about two real numbers, not a fitted
line or a projection.

**What it deliberately does not do**: it never combines attendance and
assessment performance into one composite "outcome score." HPF's own
reporting tracks these as separate indicators, and merging them would
manufacture a precision neither number alone has. Two labeled trend lines,
shown independently, both with their own "not enough history yet" empty
state when fewer than two months have data — same "no unearned precision"
standard `SCHOOL-360.md`'s digital-learning period and Teacher 360's ICT
Adoption proxy already apply.

**Ordering**: every other tab in every "360" profile in this app is
newest-first. Progress's month-by-month table is oldest-first on purpose —
it's the one tab where the point is watching a number move over time, and
that reads left-to-right, not most-recent-first.

## States

- **Loading**, **Error+Retry**, **Empty** — identical shape to School 360
  and Teacher 360, via the shared `x360Gate`. The top-level "learner record
  itself failed to load" path has a retry button from the start (the bug
  found and fixed in both prior profiles after they'd already shipped
  without one — this one didn't repeat it).

## Loading

Learner → [attendance + digital engagement + this school's classes, in
parallel] → [enrollments matched by name, to find which classes this
learner is actually in] → [assessments for those matched classes] →
[submissions matched by name against those assessments]. Four sequential
stages rather than two — one stage more than School/Teacher 360 need,
because bridging the name/id gap for Assessments takes an extra
round-trip School and Teacher 360's fully-id-based joins didn't require.

## Authorization

No new RLS — every query already runs through the has_perm()-plus-row-scope
policies from the RBAC pass (`AUTH-RBAC.md`), scoped to `learners`,
`attendance`, `coursework`, exactly as everywhere else.

## Responsiveness

Same modal shell, metric grid, and tab bar as School 360 and Teacher 360 —
no new CSS. Verified at 768×1024: no horizontal page overflow, grid
collapses to 2 columns, tab bar scrolls rather than wraps.
