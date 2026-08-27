# School 360

A unified, read-only profile for one school — 11 tabs over data that
already exists in Postgres. Opened from Master Data Management → Schools
(the layers icon on any school row). Nothing here is a new table or a
second copy of a school record: every tab queries the same rows every
other panel in this app already reads, scoped to one `school_id` (or, for
the handful of tables still matched by name — `classes`, `field_reports`,
`school_officer_assignments`, a documented pre-existing limitation, see
`SCHEMA.md` — the school's own `name`).

## Tabs

Overview, People, Learning, Digital Learning, Infrastructure, Devices,
Field Visits, Assessments, Attendance, Actions, Evidence.

| Tab | Reads |
|---|---|
| People | `profiles` (teachers, school leader) + `school_officer_assignments` (assigned field officer) |
| Learning | `classes` + `assignments` |
| Digital Learning | `kolibri_activity` + `library_activity` + `learning_activity`, merged and sorted |
| Infrastructure | `school_facilities` (one row per school) |
| Devices | `devices` + `device_maintenance` |
| Field Visits | `field_reports` (the table actually in use — see `SCHEMA.md` on why `field_visits` is still schema-only) |
| Assessments | `assessments` + `submissions`, scoped through this school's classes |
| Attendance | `attendance_records`, scoped through this school's learners |
| Actions | `interventions` + `action_items` |
| Evidence | `evidence`, matched against this school's interventions and M&E values (polymorphic `ref_table`/`ref_id`) |

**Why read-only.** Every one of these tables already has a place to
create, edit, or archive its rows — Master Data Management for
Schools/Teachers/Learners/Devices/Infrastructure, the admin dashboard's
own Interventions and Evidence panels for the rest. A second CRUD surface
here would just be two places that can drift out of sync; this view exists
to answer "what does this school look like right now," not to duplicate
the tools that change it.

**Why nothing is cached across visits.** Closing the panel discards its
state. Reopening a school re-reads the database. Nothing about a school
lives anywhere but the tables it was always in.

## The Overview metrics

Every metric carries all four of: current value, reporting period, last
updated, and data source — not just a number.

| Metric | Value | Period | Source |
|---|---|---|---|
| Learner population | Active learners (archived count noted separately) | "Current roster" | `learners` |
| Teacher population | Active teachers | "Current roster" | `profiles` (role=teacher) |
| Programme participation | Active programme names, or a count | "Current" | `school_programmes` |
| Teacher training progress | Trained / total teachers | "All-time" | `teacher_training` |
| Digital learning activity | Event count | the *actual observed* date range of the events returned, not a claimed window — see below | `kolibri_activity` / `library_activity` / `learning_activity` |
| Device status | Count per status (active/faulty/retired) | "Current" | `devices` |
| Infrastructure status | Amenities present / total | "Current" | `school_facilities` |
| Latest field visit | Visit type + date | — (a point-in-time fact, not a period) | `field_reports` |
| Open issues | Open device tickets + open interventions | "Current" | `device_maintenance` · `interventions` |
| Key M&E indicators | Indicators tracked (with a snapshot table of value vs. target underneath) | latest recorded period | `me_indicator_values` |

**On "reporting period" for activity data**: the digital-learning and
attendance queries have no server-side date filter — they return what
exists (capped at a row limit for the very largest tables). The period
shown is the true min–max date actually present in what came back (e.g.
"18 Aug 2026 – 20 Aug 2026"), computed from the data, not a "last 30 days"
label the query doesn't actually enforce. Stating a window the code
doesn't implement would be exactly the kind of unearned precision this
build is trying to avoid.

**Ten independent metrics, ten independent empty states.** A school with
no teacher_training rows shows "No data yet" for training specifically
while every other metric renders normally — there is no single "this
school has no data" gate, because that would misrepresent a school that's
fully staffed but has simply never logged a training record.

## States

- **Loading**: the moment a school is opened, before its first query
  resolves — separate from any one tab's own loading, since the school
  record itself (name, code, county — the modal header) has to exist
  before any tab can render.
- **Error**: a load failure shows what broke and a Retry button that
  re-runs the whole load, not just the failed piece — simpler to reason
  about than partial retries, and cheap enough on a per-school dataset
  this size.
- **Empty**: every tab and every Overview metric states plainly when a
  table has nothing for this school, with a specific noun ("No teachers
  linked to this school," not "No data") — see `STORAGE-AUDIT.md`'s and
  the RBAC pass's own standing rule against fabricating numbers to paper
  over a table nobody has populated yet.

## Authorization

No new RLS — every query already runs through the has_perm()-plus-row-scope
policies from the RBAC pass (`AUTH-RBAC.md`), scoped to `schools`,
`people`, `learners`, `devices`, `infrastructure`, `field_ops`,
`coursework`, `attendance`, `interventions`, `evidence`, and `me` exactly
as everywhere else. An "authorized user" who can't see a given table's
rows for this school doesn't get an error — they get that tab's ordinary
empty state, since RLS returning zero rows and a table genuinely having
zero rows are indistinguishable from the client, and treating the former
as a special case would leak information about *why* it's empty.

## Responsiveness

The metric grid is `repeat(auto-fill, minmax(240px, 1fr))` — 4 columns on
desktop, 2 on a tablet-width viewport, no media query needed. The tab bar
scrolls horizontally rather than wrapping (`overflow-x: auto`, the same
rule Master Data Management's own tabs already use). Verified at 768×1024
(tablet) and desktop width: no horizontal page overflow, tab bar and
metric grid both reflow correctly.
