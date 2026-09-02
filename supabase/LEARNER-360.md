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

## Identity — resolved (patch-33)

**Every tab in this view now resolves through `learners.id` alone.**
Attendance, Digital Engagement, enrolments and Assessments are all direct
`learner_id` joins; there is no name matching anywhere in this view.

This section previously documented a real gap: `attendance_records`,
`kolibri_activity`, `library_activity` and `learning_activity` referenced
`learners(id)` properly, but `enrollments.learner_id` and
`submissions.learner_id` were nullable and never populated, so a roster
entry's only identity was its typed `name`. The Assessments tab had to
bridge by matching that name within the learner's school — best-effort,
and capable of attributing one child's results to another wherever two
learners shared a name.

[patch-33](patch-33-learner-identity.sql) closed it:

- `learners.id` stays canonical; `learners.learner_code` (`HPF-L-000001`)
  is its portable, human-quotable form.
- Database triggers guarantee every **new** enrollment and submission
  carries a stable `learner_id`, whichever client writes it.
- A reconciliation pass linked the historical rows it could prove, and
  **flagged rather than guessed** the rest — ambiguous names and unknown
  people land in `learner_identity_reviews` with every candidate recorded.

Consequence worth stating plainly: a learner whose records are still
unresolved shows **no** records here. That is the truth, and it is visible
and fixable in the review queue — which is strictly better than showing
someone else's data with borrowed precision.

See [LEARNER-IDENTITY.md](LEARNER-IDENTITY.md) for the full strategy.

(The separate `classes.school = schools.name` text bridge that School 360
also uses is unrelated to learner identity and still stands — see
`SCHEMA.md`.)

## Tabs

Overview, Attendance, Digital Engagement, Assessments, Progress — the
literal pipeline this feature was requested as.

| Tab | Reads |
|---|---|
| Attendance | `attendance_records`, direct `learner_id` join |
| Digital Engagement | `kolibri_activity` + `library_activity` + `learning_activity`, direct `learner_id` join, merged and sorted |
| Assessments | `assessments` + `submissions`, direct `learner_id` join through this learner's enrolled classes |
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
| Assessments taken | Count + average score | observed date range | `submissions`, joined on `learner_id` |
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
parallel] → [enrollments `where learner_id = …`, to find which classes this
learner is in] → [assessments for those classes] → [submissions
`where learner_id = …`]. Four sequential stages: the extra round-trips
exist because a learner's classes must be known before their assessments
can be, not because of any name bridge — every stage joins on ids
(patch-33).

## Authorization

No new RLS — every query already runs through the has_perm()-plus-row-scope
policies from the RBAC pass (`AUTH-RBAC.md`), scoped to `learners`,
`attendance`, `coursework`, exactly as everywhere else.

## Responsiveness

Same modal shell, metric grid, and tab bar as School 360 and Teacher 360 —
no new CSS. Verified at 768×1024: no horizontal page overflow, grid
collapses to 2 columns, tab bar scrolls rather than wraps.
