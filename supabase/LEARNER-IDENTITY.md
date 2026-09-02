# Canonical learner identity

Implemented by [patch-33](patch-33-learner-identity.sql). Ends the use of
name matching as an identity mechanism — see
[Learner 360](LEARNER-360.md), whose bridge this replaces.

## What was actually wrong

Inspected before designing anything. **All six learner-referencing foreign
keys already pointed at `learners(id)`** — patch-31 fixed the last one that
didn't. The FK targets were never the problem:

| Real defect | Consequence |
|---|---|
| `enrollments.learner_id` and `submissions.learner_id` nullable, with nothing populating them | A roster entry's only identity in practice was its typed `name` |
| No unique constraint on `(class_id, learner_id)` | The same learner could be enrolled twice in one class |
| The "add learners" form created a **new** `learners` row per name, unconditionally | Enrolling one child in two classes produced **two** learner records for that child |
| No portable identifier | A UUID cannot be written on a Kobo form, read down a phone, or carried between schools |
| `kobo_submissions` had no learner link at all | Requirement 8 unaddressed |

Learner 360 then had to bridge by name, which its own docs called
best-effort — and which, wherever two learners share a name, silently
attributes one child's attendance and results to another.

## The strategy: three identifiers, one job each

| Identifier | Role |
|---|---|
| **`learners.id`** (uuid PK) | **Canonical.** Internal, immutable, never displayed. Every relationship in the schema resolves to this. Already existed — patch-33 makes it actually reliable rather than replacing it. |
| **`learners.learner_code`** (new, `HPF-L-000001`) | **Portable + human-quotable.** Auto-generated from a sequence, unique, stable for life. Survives a school transfer, unlike an admission number the new school reissues. This is what goes on a Kobo form or an import sheet. |
| **`(school_id, admission_number)`** | The **school's own** natural key. Unique since patch-26; still nullable because not every school issues one. |

## The nine relationships

| # | Relationship | Resolves through | Status |
|---|---|---|---|
| 1 | Stable identifier | `learners.id` + `learner_code` | ✅ |
| 2 | School | `learners.school_id` → `schools.id` | ✅ already existed |
| 3 | Enrollment | `enrollments.learner_id` → `learners.id` | ✅ now populated + enforced by trigger |
| 4 | Assessment | `submissions.learner_id` → `learners.id` | ✅ now populated + enforced by trigger |
| 5 | Coursework | `assignment_results.enrollment_id` → `enrollments.learner_id` | ✅ already `NOT NULL`; stable once enrollments carry ids |
| 6 | Attendance | `attendance_records.learner_id` → `learners.id` | ✅ already `NOT NULL` |
| 7 | Learning activity | `learning_activity` / `library_activity`.`learner_id` | ✅ already existed |
| 8 | Kobo | `kobo_submissions.learner_id` + `learner_ref` | ✅ new — resolved by code/admission number **only** |
| 9 | Kolibri | `kolibri_activity.learner_id` | ✅ already existed |

## Forward integrity — the gap cannot reopen

Guaranteed at the **database**, not in one form handler, so any client gets
the same behaviour:

**`enrollments_resolve_learner()`** (BEFORE INSERT on `enrollments`):

| Situation | Action |
|---|---|
| Name identifies exactly one learner in the school | Link to it |
| Name identifies nobody | Create a learner and link. *Not a guess* — a new name on a roster asserts that a person exists; it does not claim they are some specific existing person |
| Name identifies **several** | Leave `learner_id` null, file a review row. **Never guess** |
| Class's school is unknown | Leave null, file a review row |

**`submissions_resolve_learner()`** (BEFORE INSERT on `submissions`)
resolves against the **assessment's class roster** — by then the roster
already carries stable ids, so this is a roster lookup, not a name-identity
lookup. Ambiguous or unknown → null + flagged.

The client-side learner creation was **deleted**, not duplicated: it was
what caused the double-learner bug, and reimplementing this logic in the
browser would only let the two drift.

## Historical data — reconciled, never guessed

`hpf_reconcile_learner_identities()` is idempotent and safe to re-run. It
**never** overwrites an existing `learner_id` and **never** deletes
anything.

| Outcome | Handling |
|---|---|
| Exactly one match | Linked, and recorded with the method used so it is auditable and reversible |
| No match | `learner_id` stays null; flagged `no_candidate` |
| Several matches | `learner_id` stays null; flagged `ambiguous`, with **every** candidate stored so a human can choose |

`learner_id` was deliberately **not** made `NOT NULL`. A historical row
whose identity genuinely cannot be established must stay null and be
reviewable — forcing it would mean inventing an identity, which is exactly
what must not happen.

### The review queue

`learner_identity_reviews` — one open row per unresolved record, carrying
the observed name, the school, the reason, and the full candidate list.
Statuses: `open` → `resolved` / `dismissed`. RLS matches the learner
directory (`has_perm('learners','view'/'edit')`).

**A learner with unresolved records correctly shows *no* records in
Learner 360** — which is the truth, and is visible and fixable in the
queue, rather than showing someone else's.

## Kobo (requirement 8)

Kobo forms carry a **written** identifier — a learner code or admission
number — never a typed name. `hpf_resolve_learner_ref()` therefore matches
on those two only and refuses names outright (verified by test 16). An
unmatched reference is flagged like any other unresolved record.

## Client changes

| Location | Change |
|---|---|
| `#addLearnerForm` handler | Removed the client-side `learners` insert entirely — the trigger resolves-or-creates correctly and atomically. Reads back the trigger-assigned `learner_id` via `.select()` |
| `syncResults()` | Omits `learner_id` when the device holds no real one, letting the trigger resolve it, instead of forcing an explicit `null` |
| `loadLearner360()` | **Name-match bridge removed.** Enrollments and submissions are now `eq("learner_id", …)` joins only |
| Learner 360 Assessments tab | The "matched by name / best-effort" disclaimer is replaced by a statement that identity resolves through `learner_id` |
| Learner 360 header comment | Rewritten — it documented the old two-ID-space gap as a permanent condition |

## Validation (2026-09-01, live database, all rolled back)

Twenty checks across four suites; all passed.

**Identity & forward integrity**
| Test | Result |
|---|---|
| 1 `learner_code` auto-generated, unique, `HPF-L-` format | ✅ |
| 2 Unique name auto-links the enrollment | ✅ |
| 3 **Ambiguous name NOT guessed** — `learner_id` stays null | ✅ |
| 4 Ambiguous flagged `open` with **both** candidates stored | ✅ |
| 5 New name creates a learner and links (matching is whitespace/case-normalised) | ✅ |
| 6 Same person in a 2nd class → same stable id, no duplicate learner | ✅ |
| 7 Double-enrolment in one class rejected | ✅ `unique_violation` |

**Historical reconciliation**
| Test | Result |
|---|---|
| 8 Historical unlinked rows preserved | ✅ 3 preserved |
| 9 Reconcile links only the certain one | ✅ 1 linked, 2 flagged |
| 10 Certain row linked by stable id | ✅ |
| 11 Ambiguous + no-candidate both left null — none guessed | ✅ |
| 12 Both flagged with correct reasons | ✅ `ambiguous`, `no_candidate` |
| 13 Re-running is idempotent | ✅ 0 re-linked, no duplicate reviews |

**Kobo**
| Test | Result |
|---|---|
| 14 Resolves by `learner_code` | ✅ |
| 15 Resolves by admission number within school | ✅ |
| 16 **Refuses a bare name** | ✅ null |

**Client behaviour + full chain**
| Test | Result |
|---|---|
| C1 Same person, two classes, as the fixed client now writes → **one** learner | ✅ (this is the duplicate-learner bug, confirmed fixed) |
| C2 Submission sent with no `learner_id` → resolved from the roster | ✅ |
| C3 Submission for a non-roster name → null + flagged | ✅ |
| C4 / chain Learner → enrollment → coursework → assessment → attendance → digital activity → Kobo, **joined on ids only, zero name predicates** | ✅ all resolved |

The chain test traverses every one of the nine relationships in a single
query containing no name comparison anywhere.

All test data ran inside `BEGIN … ROLLBACK`; `learners`, `enrollments`,
`submissions`, `learner_identity_reviews` and `schools` were verified back
at their prior row counts afterwards. All seven new functions carry a
pinned `search_path`.

## Not done

- **No admin UI for the review queue.** The table, its RLS and its
  candidate data exist and are queryable; a panel to work through it is a
  separate, small piece of client work.
- `learner_id` remains nullable, deliberately (see above).
- Kobo's `learner_ref` is not yet populated by `kobo-sync` — no real form
  field is mapped to it yet (see [KOBO-INTEGRATION.md](KOBO-INTEGRATION.md)).
  The resolution function is ready for when one is.
