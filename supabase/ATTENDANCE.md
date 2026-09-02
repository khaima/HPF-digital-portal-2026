# HPF attendance rate — definition and derivation

`school_returns.attendance_rate` used to be a number a head typed, with
`attendance_records` sitting beside it holding the real daily marks and
nothing connecting the two. [patch-32](patch-32-attendance-derivation.sql)
closes that: the rate is now **derived** from the marks whenever marks
exist, and always says where it came from.

No second attendance table was created — [patch-18](patch-18-attendance.sql)'s
`attendance_records` remains the one and only store. No historical return
was removed or altered; a return filed before daily marking existed keeps
its typed value and is simply labelled `manual`.

## The definition

```
                     marks where status ∈ (present, late)
attendance rate  =  ────────────────────────────────────────  × 100
                  marks where status ∈ (present, late, absent)
```

Implemented once, in `public.hpf_attendance_stats(school, year, term)`.
Every consumer resolves to that one function, so no two views can disagree.

| | |
|---|---|
| **Numerator** | Marks with status `present` or `late`. The learner was in class. Punctuality is a different indicator; the return asks for "Average attendance rate (%)", not "on-time rate". |
| **Denominator** | Marks with status `present`, `late` or `absent` — every session where the learner's attendance was actually determined. |
| **Reporting period** | The term of the return, via `hpf_term_range(year, term)`: Term 1 = Jan 1–Apr 30, Term 2 = May 1–Aug 31, Term 3 = Sep 1–Dec 31. Marks outside the window are excluded. The function is `IMMUTABLE`, so the same term always resolves to the same window — this is what makes a figure reproducible months later. |
| **School scope** | Every class whose `classes.school` equals the return's `school`. Attendance is marked against a class, and the class carries the school name `school_returns` is keyed on — a direct join, not a name heuristic. |
| **Learner scope** | Every learner with at least one mark in that school's classes inside the window. A learner who was never marked contributes nothing rather than being assumed absent. |
| **Absence handling** | `absent` counts in the denominator only (a session the learner missed). `excused` is excluded from **both** — see below. |
| **Missing data** | Denominator of 0 → `NULL`, never `0`. No marks recorded is not the same fact as nobody attending, and the UI never renders it as `0%`. |

### Why `excused` is excluded from both

An authorised absence (illness with a note, bereavement, a sanctioned
event) is neither a session the learner failed to attend nor one the
school failed to deliver. Counting it as absent penalises a school for
something the indicator is not meant to detect; counting it as present
overstates attendance. Excluding it measures what HPF actually wants to
know — of the sessions where attendance was genuinely in question, how
many did the learner attend.

The excused count is **not discarded**: it is stored on the return as
`attendance_excused` and displayed, so anyone can recompute on a
different definition if HPF ever wants one.

## The three states

`school_returns.attendance_source` — always one of exactly three, never
guessed:

| State | Meaning | Provenance columns |
|---|---|---|
| `calculated` | Derived from real daily marks by the trigger | `attendance_present`, `attendance_expected`, `attendance_excused`, `attendance_learners`, `attendance_computed_at` all populated |
| `manual` | Typed on the return; no daily marks exist for this school+term | all null |
| `NULL` (missing) | Nothing recorded and nothing typed | all null |

Every surface that shows a rate shows which of the three it is — see
[Audit of affected code](#audit-of-affected-code).

## Preventing contradictory manual values

**When marks exist, the calculated figure wins and a typed one is
discarded.** Enforced in two places, deliberately:

1. **Database** (`school_returns_derive_attendance`, BEFORE INSERT/UPDATE) —
   the real guarantee. Whatever any client sends is overwritten by the
   calculated value. Tested: a return filed with a contradictory `95` was
   stored as the calculated `70`.
2. **UI** (`attendanceField`) — when a return is already `calculated` the
   input is replaced by the derived value plus its badge and derivation.
   This does not enforce anything the database does not already enforce;
   it stops a head typing a number that would silently vanish.

**Marks usually arrive after the return is filed**, so a second trigger
(`attendance_refresh_school_return`, on `attendance_records`) re-derives
any affected return whenever marks are inserted, updated or deleted. The
stored value is therefore always a cache of the function, never an
independent number that can drift.

### No override flag — and why

A head cannot overrule a figure the database can prove. Partial coverage
(some classes marking daily, others not) is a real risk, but the honest
answer is to *surface* it — `attendance_learners` and
`attendance_expected` are shown alongside every calculated rate — not to
let a typed guess quietly replace it. If HPF later decides an override is
genuinely required, the place to add it is one branch in
`school_returns_derive_attendance` plus a fourth `attendance_source`
value; nothing else would need to change.

The one case a manual figure *is* authoritative is a school not yet
marking daily attendance at all — the common case today, and exactly what
`manual` labels.

## Reproducing any figure by hand

Every calculated rate is displayed with the numbers behind it, e.g.

> Calculated from **7** attended of **10** expected marks (2 excused,
> excluded) across 3 learners · `attendance_records`

7 ÷ 10 × 100 = 70%. To recompute from SQL:

```sql
select * from hpf_attendance_stats('Calc School', 2026, 'Term 2');
-- present_count | expected_count | excused_count | learner_count | class_count | rate
--             7 |             10 |             2 |             3 |           2 |   70
```

## Audit of affected code

Everything that reads `attendance_rate`, and what changed:

| Location | Before | After |
|---|---|---|
| `school_returns.attendance_rate` | Typed integer | Derived when marks exist; six provenance columns added |
| Return form (`attendanceField`) | Free number input, always | Input only when no marks exist; otherwise the derived value + badge + derivation |
| Return submit handler | Always sent typed `attendance_rate` | Field absent when derived, so `null` is sent and the trigger recomputes |
| Returns table (school leader) | `70%` or `—` | Adds `calculated`/`manual` sub-label and a hover explaining the figure |
| School-leader KPI card | `attendance_rate ?? 0` — rendered **0** when missing | `Not recorded` when missing; badge + full derivation when present |
| `kpiCard` / `statTiles` | No provenance support | Optional `badge`, `note`, `missing` — used only where a provenance story exists |
| `aggregateReturns` | `attendance` mean only | Adds `attendanceCalculated` / `attendanceManual` / `attendanceMissing` counts |
| Admin scorecard tile | "enrolment-weighted" | "enrolment-weighted · N calculated, N manual, N missing" |
| Programme Overview meter | Bare mean | Adds "N schools · N calculated from daily records, N manually entered" |
| `schoolStatus` | One grey: "No return filed" | Two: "No return filed" vs "No attendance recorded" — different problems |
| School 360 / Learner 360 | Compute `present / all marks` for their own display | **Unchanged** — they report raw marks for one school/learner, not the termly return figure. See note below. |

### Note on School 360 / Learner 360

Both compute `present ÷ all marks` for their own attendance panels, which
is a *different* number from the termly return rate (it counts `excused`
and `late` differently and is not term-scoped). They were left alone
because they answer a different question — "what do this learner's marks
look like" rather than "what is this school's termly attendance rate" —
and they already label their source as `attendance_records`. Aligning
them to `hpf_attendance_stats` would be a reasonable follow-up for
consistency, but it is not required for the return figure to be correct
and was out of scope for this pass.

## Tests (2026-09-01, all against the live database, rolled back)

| Test | Expected | Result |
|---|---|---|
| A. Known marks: 5 present, 2 late, 3 absent, 2 excused | 7/10 = 70%, excused excluded | ✅ `present 7, expected 10, excused 2, learners 3, classes 2, rate 70` |
| Out-of-period marks (2 absent in September) present | Excluded from a Term 2 figure | ✅ excluded (would otherwise have given 58%) |
| B. Return filed with contradictory typed `95` | Calculated 70 wins | ✅ stored 70, source `calculated` |
| C. School with no marks, typed `88` | Preserved as manual | ✅ 88, source `manual`, provenance null |
| D. School with no marks, nothing typed | Missing | ✅ null, source null |
| E1. Return filed first, typed 90, no marks | manual 90 | ✅ |
| E2. Marks entered afterwards (3 present, 1 absent) | Auto-recalculates to 75, calculated | ✅ |
| E3. A mark corrected absent → present | Auto-recalculates to 100 | ✅ |
| E4. All marks deleted | Reverts to **missing**, not a phantom manual 100 | ✅ (this test found and fixed a real bug — see below) |
| E5. Head then types 82 | manual 82 | ✅ |
| UI: edit a calculated return | No editable input | ✅ shows value + badge + derivation |
| UI: edit a manual return | Editable input, pre-filled | ✅ `88` |
| UI: three states in the returns table | Distinct rendering each | ✅ `70% calculated` / `88% manual` / `—` |
| Chain: marks → calc → return → KPI → dashboard | Consistent 70% throughout | ✅ KPI 70% calculated; scorecard `79% · 1 calculated, 1 manual, 1 missing`; overview `70% · 1 school · 1 calculated` |

**Bug found by test E4 and fixed:** deleting every mark left the last
calculated value on the row and relabelled it `manual` — inventing a
manual entry nobody typed. The trigger now reverts a previously-calculated
value the writer did not themselves change back to missing, while still
honouring a genuinely typed replacement (E5).

All test data was written inside `BEGIN … ROLLBACK`; `school_returns`,
`attendance_records`, `learners` and `schools` were verified back at their
prior row counts afterwards.
