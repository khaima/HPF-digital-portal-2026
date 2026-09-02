# New field report — the cascading form

"New field report" (the field officer's home page) now walks through four
steps in order, each narrowing the next:

**County → School → Visit type → Form** → fill in the value → submit.

Server support is [patch-36](patch-36-field-report-me-link.sql); the client
is `app.js`'s `pageFieldOfficer()` / `wireFieldOfficer()`, using data
already established this project (`school_officer_assignments`, `schools`,
`me_indicators`) — no new table.

## The four steps

1. **County** — for a field officer (or programme_manager / me_officer /
   staff, who share the same assigned-school flow), this lists only the
   counties where they actually have an assigned school, not all 47. Admin
   keeps the existing free-text school field and full county list — the
   RLS bypass they've always had (`is_admin() OR assigned_to_school(...)`)
   makes an assignment-scoped picker meaningless for that role.
2. **School** — filtered to the selected county's assigned schools. Picking
   a school outside the officer's assignment list was never possible
   before this feature either — `field_reports`' insert policy has always
   checked `assigned_to_school()` — the difference is the UI now groups by
   county instead of listing every assigned school flat.
3. **Visit type** — exactly four options, each mapped to an M&E scorecard
   pillar (`me_indicators.scorecard_pillar`, patch-21): Learning →
   `education`, Infrastructure → `infrastructure`, ICT → `ict`, MEP →
   `mep`. The same four the M&E scorecard's own pillar tabs use
   (`dashboards.js`'s `PILLAR_TO_ME`/`scPillar`), so a "Learning" visit and
   a "Learning" scorecard activity mean the same pillar.
4. **Form** — `me_indicators` filtered to that pillar. This is the M&E
   data model itself, not a hardcoded list: whatever an M&E officer or
   admin has defined for that pillar (M&E dashboard → Add activity, or any
   future indicator-management screen) appears here automatically, because
   both read the same table. Picking one reveals a **Value** field labelled
   with that indicator's name and unit; filling it in and submitting saves
   both the field report and the measurement.

## Why the form step isn't always mandatory

`me_indicators` can genuinely have zero rows for a pillar — nobody in M&E
has defined one yet. Making the form step required in that state would
mean an officer literally cannot file a report for that visit type until
someone else populates data elsewhere, which would have broken the
existing, working "New field report" flow for no upside. Instead:

- A pillar **with** indicators: the Form select becomes `required`, and so
  does the Value field once a form is picked.
- A pillar **with none**: the Form select stays optional, a plain-language
  notice explains why ("No forms have been set up for this visit type yet
  — ask an M&E officer to add one. You can still submit this report
  without a linked measurement"), and the report submits normally with no
  M&E link.

## What actually gets written

`field_reports` gained two nullable columns — `me_indicator_id` (FK to
`me_indicators`) and `me_value` (numeric) — rather than a second table.
That was deliberate: this table already has everything the offline-first
PWA built for it (patch-35) — the IndexedDB outbox, `client_id`
idempotency, the audit trigger. Riding inside the same row means a field
report with a linked measurement gets all of that for free; a second write
path would have meant re-deriving retry/idempotency/offline behaviour for
one more table.

`field_reports.visit_type` still stores the human label ("Learning"), not
the pillar code — nothing about existing display code (`dashboards.js`'s
recent-visit list, Learner/School 360, etc.) changes meaning. The pillar
code is only ever used client-side, to filter the Form dropdown, and
travels to Postgres solely via `me_indicator_id` — the indicator row itself
already carries its own `scorecard_pillar`.

### The derivation trigger

An `AFTER INSERT` trigger on `field_reports` (`derive_me_indicator_value()`)
does the actual `me_indicator_values` write, `SECURITY DEFINER`, because
the permission matrix gives `field_officer` `has_perm('me','view')` and
`has_perm('me','export')` but deliberately **not** `has_perm('me','create')`
— an officer may read indicators to pick one, not write measurements
directly. The trigger performs that one write on the officer's behalf,
scoped strictly to the row `field_reports`' own RLS just accepted as their
genuine, assigned-school visit. Same shape as patch-32's attendance
derivation and patch-34's notification producers.

What it does, in order:

1. No-op if `me_indicator_id` or `me_value` is null (the common case: no
   form was linked).
2. Resolves `school_id` by matching `field_reports.school` (free text) to
   `schools.name`. No match — a typo, or an admin's free-text entry that
   isn't a real school row — skips the M&E write silently; the field
   report itself is already saved either way.
3. Computes `period_year`/`period_term` from the report's `created_at`,
   using the same term boundaries `hpf_term_range()` (patch-32) already
   defines: Term 1 Jan–Apr, Term 2 May–Aug, Term 3 Sep–Dec.
4. Upserts into `me_indicator_values` on the table's own unique constraint
   `(indicator_id, school_id, period_year, period_term)` — a second visit
   to the same school for the same indicator in the same term **updates**
   that period's reading rather than silently duplicating it. This matches
   the convention the M&E module's own `recordActivityScore()`
   (`dashboards.js`) already uses: the latest reading for a period wins.

Verified with a rolled-back transaction against the real schema: two
inserts for the same indicator/school/term left exactly one
`me_indicator_values` row holding the *second* value; a report with no
indicator picked, and one against a school name with no match in `schools`,
both inserted cleanly with no M&E row created and no error.

## Known limits

- **`me_indicators` currently has no seeded rows for any pillar** on the
  live database, so every visit type shows the "no forms yet" notice until
  an M&E officer or admin adds at least one activity for that pillar (M&E
  dashboard → Add activity, which sets `scorecard_pillar`). The cascade and
  the derivation trigger are both real and tested; there is simply nothing
  to pick yet.
- **County resolution needs `schools.county` set** for each assigned
  school. If it's missing, or the lookup fails (offline, RLS), the county
  step falls back to the full county list and the school step falls back
  to the officer's full assigned list, unfiltered — never a dead end, just
  not narrowed.
