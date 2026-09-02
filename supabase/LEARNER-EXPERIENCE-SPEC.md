# Learner experience — product specification & recommended architecture

**Status: §4's Option D is implemented (2026-09-01).** This started as a
design-only document; the login model it recommended has since been
built. See [Implementation status](#implementation-status) at the bottom
for exactly what shipped, what's still a fast-follow, and what remains
correctly deferred (courses, achievements — see items 4 and 12 below,
unchanged).

## 1. What's actually mocked today (verified against the live code and database)

The learner dashboard (`learnerBody()`, `dashboards.js`) is not uniformly
fake — it's two genuinely real, database-backed sections sitting beside
entirely fabricated decoration:

| Section | Backing | Status |
|---|---|---|
| Stat tiles ("Courses enrolled: 6", "Lessons completed: 48", "Day streak: 12", "Badges earned: 9") | `DASH.learner.stats` (`data.js`, static) | **Fabricated.** Fixed numbers, never computed. |
| "Courses" + progress bars | `DASH.learner.courses` (static) | **Fabricated.** No `courses` table exists anywhere in the schema. |
| Content catalogue — class cards, channel chips, "Continue learning" | `KOLIBRI.learner.*` (static) | **Fabricated.** A fake Khan Academy/CK-12/PhET/TED-Ed catalogue with fake progress %, redundant with the real section below. |
| My Assignments (assignments, assessments, live sessions) | `learnerAssignments()` → real `assignments`, `assignment_results`, `assessments`, `questions`, `submissions` tables via `classesCache` | **Real.** Already correctly built. |
| Learning Resources | `learnerResources()` → real `digital_learning` table (patch-21) + class-targeted shares | **Real.** Already correctly built. |

So this is not a rebuild — it's **removing a redundant, inconsistent fake
layer that sits next to a real one**, then filling the gaps the real
layer doesn't cover yet (progress, activity, achievements).

## 2. Ground truth: what the database already models, and where it's empty

Verified live, 2026-09-01. Every one of these tables exists, has real RLS,
and currently has **zero rows** — this is a greenfield design against
real infrastructure, not a migration of real learner data.

| Table | Purpose | Learner FK | Live rows |
|---|---|---|---|
| `learners` | The learner's actual identity (patch-13/MDM): name, DOB, gender, `school_id`, admission number, guardian contact, grade | — | 0 |
| `enrollments` | Roster entry — a learner in a class | `learner_id → learners(id)`, nullable | 1 (nullable, unset) |
| `classes` | A teacher's class | `owner_id → profiles(id)`, `school` (**text, not a FK** — see §3) | few |
| `assignments` + `assignment_results` | Real per-class assignments and per-roster-entry results | `assignment_results.enrollment_id → enrollments(id)` | 0 |
| `assessments` + `questions` + `submissions` | Real quizzes, with question banks and scored attempts | `submissions.learner_id → **profiles(id)**` | 0 |
| `attendance_records` | Real per-day attendance (patch-18) | `learner_id → learners(id)` | 0 |
| `kolibri_activity` / `library_activity` / `learning_activity` | Digital engagement timeline (patch-13) | `learner_id → learners(id)` | 0 (see [KOLIBRI-FEASIBILITY.md](KOLIBRI-FEASIBILITY.md) — no producer exists yet) |
| `digital_learning` | HPF's real content catalogue | — | some (patch-21 seed) |

**One confirmed structural bug, load-bearing for this whole design:**
`submissions.learner_id` references `profiles(id)`, while every other
learner-scoped table references `learners(id)`. A learner has no
`profiles` row — no email, no Supabase Auth account, ever (§4). That FK
is **currently unsatisfiable for a real learner** and is why
`LEARNER-360.md` already documents assessments as reachable only by a
best-effort name match, not a real join. **Fixing `submissions.learner_id`
to reference `learners(id)` is a prerequisite for item 8 (Assessments)
and item 9 (Scores) to ever be real for a learner — called out here,
not fixed here.**

The other load-bearing gap: `teaches_learner(lid)` — the RLS helper that
already gates `kolibri_activity`/`library_activity`/`learning_activity`
read/write access (`activity_visible()`, confirmed live) — depends on
`enrollments.learner_id` being populated. It is 0-for-1 today. **Every
roster entry needs a real `learners` row and a populated
`enrollments.learner_id` before any of the RLS this spec relies on can
actually pass.** This is the single most important prerequisite in this
whole document.

## 3. The 14 items

### 1. Learner identity
The `learners` row **is** the identity — not `hpf_users`, not a Supabase
Auth user. It already has the right shape (name, DOB, gender, school,
admission number, guardian contact, grade). A login credential (§2) is a
thin pointer *at* a `learners.id`, never a second, disconnected identity
the way `hpf_users` is today.

### 2. Learner login model
See the full comparison in §4 — this is the item the task asked to be
evaluated explicitly. Recommended: **Option D**, a school/class-scoped
session (not a personal credential) with narrow, server-validated writes.

### 3. Learner school relationship
`learners.school_id → schools` already exists and is the right link.
**Inconsistency worth flagging**: `classes.school` is free text, not a
`school_id` FK, while `learners.school_id` is a real foreign key — the
one place in this design where a learner's school and their class's
school aren't provably the same row. Recommend closing this — giving
`classes` a real `school_id` — as a fast-follow schema fix, not blocking
this spec.

### 4. Courses
**Do not build a `courses` table or resurrect `DASH.learner.courses`.**
Nothing in HPF's real programme model is organized into "courses" — the
real organizing units are `classes` (what a learner is enrolled in) and
`subjects` (what `assignments`/`assessments`/`digital_learning` are
already tagged with). A learner's "courses" view should be their real
classes, grouped by real subject — not a fabricated third abstraction
layered on top of two that already exist.

### 5. Resources
Already real (`digital_learning`, `learnerResources()`) and already the
right model: HPF's own curated catalogue, plus items a teacher has
explicitly shared with a class or specific learners (`audience`/
`target_ids`, the same targeting pattern `assignments`/`assessments`
already use). Recommend extending this — subject/grade filtering — over
replacing it with `KOLIBRI.learner`'s fake catalogue. If a real Kolibri
producer is ever built (see [KOLIBRI-FEASIBILITY.md](KOLIBRI-FEASIBILITY.md)),
its content surfaces here too, not as a second, separate "Learn" tab.

### 6. Progress
No single fabricated "course progress %" number. Real progress is a
**rollup of real recorded events**: `assignment_results.pct`,
`submissions.pct`, `attendance_records` (day-level presence), and —
once a real producer exists — `kolibri_activity.progress_pct`/
`library_activity`. Anything without a real event behind it shows an
honest "not yet tracked" state, the same pattern already used for
`adminScorecard`'s M&E indicators — never a placeholder number.

### 7. Assignments
Already real and already correctly built (`assignments` +
`assignment_results`, `learnerAssignmentsFolder()`). Keep as-is.

### 8. Assessments
Already real, blocked on the `submissions.learner_id → profiles(id)`
bug in §2 above. Once fixed, a learner's own submissions become a real
join, not a name match — and the SAME fix is what
[LEARNER-360.md](LEARNER-360.md)'s admin-facing view is already waiting on.

### 9. Scores
Already stored correctly (`submissions.correct/total/pct`,
`assignment_results.score/pct`) — no new concept needed, just a real
`learner_id` join once item 8's fix lands. This is the source of truth;
nothing else should compute or store a competing "score."

### 10. Completion
Not a new stored field — a **derived status**, exactly like the existing
`assignStatusKey()`/`LA_STATUS` client logic already does (pending →
started → complete, from `pct`). Keep this as computed-on-read, not a
new column to keep in sync.

### 11. Learning activity
`learning_activity` (patch-13) is the right home for "opened a resource,"
"started an assignment," and similar events — real table, real RLS
(`has_perm('library','create') AND activity_visible(learner_id)` —
already confirmed live, already anticipates exactly the teacher-mediated
write model §4 recommends). It has never had a producer. Wiring real
client events into it is future implementation work, not this document.

### 12. Achievements — genuinely required?
**No, not yet.** Streaks and badges have zero backing data today and no
stated pedagogical purpose — they're generic edtech decoration, not one
of the outcome indicators HPF's own published impact work tracks
(attendance, dropout, learning outcomes — the exact framing the Learner
360 build already used). Recommend deferring achievements entirely until
there is a real motivational/pedagogical case *and* real underlying
activity data (attendance, submissions, learning_activity) to derive them
from honestly. A "12-day streak" with zero recorded days behind it is
exactly the kind of fabrication this whole task is about removing — don't
rebuild a new instance of it.

### 13. Offline learning
The context this whole design has to fit: intermittent connectivity,
shared classroom devices, the same conditions that make Kolibri (offline-
first by design, see [KOLIBRI-FEASIBILITY.md](KOLIBRI-FEASIBILITY.md))
the right content platform in the first place.
- **Content**: offline delivery is Kolibri's job, not this portal's to
  reimplement — the portal's job is tracking and reporting on it, per the
  Kolibri ADR's recommended Option B (scheduled/manual import).
- **Writes made offline** (a learner finishes a quiz with no connectivity):
  queue locally and flush on reconnect — reusing the *exact* mechanism
  already proven for field officers (`K_FO_OUTBOX`/`flushFoOutbox()`
  in `app.js`), not a new offline pattern invented for learners.
- **The session itself** (§2) must work fully offline once provisioned —
  a cached class/device credential and a locally-cached roster, so
  picking a learner's name never needs a network round trip.

### 14. Teacher interaction
Already substantially real and already the right shape: live sessions
(`liveSessionPanel`), assignment/assessment targeting to a class or
specific learners, real per-learner results a teacher can see. Recommend
keeping and extending this surface, not replacing it — it's the part of
the current learner dashboard that was never mocked.

## 4. Login model — the four options, evaluated

Learners have no standard Supabase Auth identity today (no email, mostly
young children, shared/limited devices) — confirmed throughout this
session and consistent with why `hpf_users` exists as a separate,
JWT-less path in the first place.

| | **A. Individual accounts** | **B. School/device sessions** | **C. Teacher-mediated access** | **D. Hybrid (recommended)** |
|---|---|---|---|---|
| **What it is** | Every learner gets a real Supabase Auth identity (password, or a synthetic email workaround) | One shared login per class/device; a learner picks their name from a roster once inside | The learner never holds any credential — a teacher's session performs every action on their behalf | A class/device is signed in as the **teacher's real Supabase account**; the learner picks their name from a roster (no password); every write is teacher-authenticated but learner-attributed, checked server-side |
| **Security** | Real per-identity RLS, but a synthetic-email workaround is a known anti-pattern (password reset/recovery breaks down for a 9-year-old with no real inbox) | Weaker at the edge — anyone with the shared device can act as any roster learner — but that already matches the real physical trust boundary (a supervised classroom), not a false promise of individual protection | Strongest in isolation (nothing learner-held to steal) but an all-or-nothing dependency on the teacher | Real RLS on every write, scoped by the *existing* `teaches_learner()`/`activity_visible()` helpers (already live, already gating `kolibri_activity` et al.) — no learner-held secret to lose, blast radius bounded to one class |
| **Usability** | Poor for young learners — a password is a real burden; better suited to older/secondary learners only | Excellent — pick-your-name matches how Kolibri itself already works (confirmed in the Kolibri feasibility research) | Poor for independent/self-paced use — nothing works without the teacher physically mediating | Excellent — same zero-password pick-your-name UX as B, but writes still land correctly attributed without the teacher clicking through every action |
| **Offline** | JWT can cache, but re-authentication (password reset, new device) needs connectivity | Excellent — the shared login is provisioned once, then works offline indefinitely; roster is local | Good only while the teacher's own session/device is present and cached | Excellent — same as B, since it *is* the teacher's normal cached session; matches item 13 |
| **Scalability** | Poor operationally — a credential to create and reset per child, across every enrollment, is a real administrative burden on already-stretched teachers | Excellent — no per-learner credential at all; a new learner is just a new roster row | Good administratively, poor functionally — doesn't support genuine independent learning at all | Excellent — no per-learner credential; provisioning is one credential per class/device, already how teacher accounts work today |

### Recommendation: **D**

Not a compromise between B and C — it's B's identity model (no
credential a child has to hold or lose) implemented through C's write
boundary (a real, permissioned adult session actually talks to Postgres),
using infrastructure that **already exists and is already live**:
`teaches_learner()` and `activity_visible()` (confirmed via
`pg_get_functiondef` against the live database) already gate
`kolibri_activity`/`library_activity`/`learning_activity` on exactly
"does the calling JWT's owner teach this learner" — the schema was built
anticipating this model; it was just never connected to a real
learner-facing login flow.

Concretely, once implemented (not now):
- The classroom device signs in **once**, as the teacher (or a
  school-scoped account), the same real Supabase Auth flow that already
  exists — no new auth system.
- "Which learner is using this device right now" is pure client-side UI
  state (pick a name from the class roster) — never an auth boundary.
- Every learner-scoped write (a resource opened, an assignment
  submitted) goes through a narrow, server-side-validated path — the
  same "SECURITY DEFINER RPC that trusts nothing from the caller except
  what it explicitly validates" pattern already proven three times this
  session (`record_local_login`, `kobo-sync`, `record_legacy_login`) —
  checking the calling teacher actually teaches the `learner_id` being
  written for, via `teaches_learner()`, before anything lands.
- Content and activity made **offline** queue locally and flush on
  reconnect, reusing `K_FO_OUTBOX`'s already-proven pattern rather than
  inventing a new one.

This is the one option that needs no new authentication mechanism, no
per-child credential burden, and no new RLS model — it completes a design
the schema already started, rather than adding a fifth option nobody
asked for.

## Implementation status (2026-09-01)

**Shipped**, per §4's recommended Option D:

- **`submissions.learner_id` fixed** to reference `learners(id)` instead
  of `profiles(id)` — [patch-31-learner-experience.sql](patch-31-learner-experience.sql).
  Zero rows existed, so this was a pure constraint swap, nothing to migrate.
- **`enrollments.learner_id` population** — turned out to already be
  implemented (`#addLearnerForm`'s submit handler already creates a real
  `learners` row per name-only roster entry). Verified live, not rebuilt.
- **The kiosk mode itself**: `coachLearnerDetail()` gained a "View their
  real dashboard" action, shown only for a roster entry with a real
  `learners.id` linked (an unlinked entry shows "Not yet linked to a
  learner record" instead — no dead affordance). Clicking it sets
  client-side-only `kioskLearner` state and renders `learnerBody()` for
  that specific learner, wrapped in a banner ("your own account is still
  signed in… Back to my view") — modeled on the existing impersonate-
  banner pattern, but deliberately **not** the same mechanism as
  `enterAccount()`/`K_IMPERSONATE`, which swaps `K_SESSION` and only
  applies to a locally-registered `hpf_users` learner. Nothing about
  authentication changed: every read/write in kiosk mode still goes out
  under the teacher's own real session, authorized by the RLS
  (`owns_class()`, `teaches_learner()`, `activity_visible()`) that
  already existed before this shipped.
- **Fabricated content removed**: `DASH.learner` and `KOLIBRI.learner`
  deleted from `data.js` (their own removal comment named the exact
  trigger condition this met). `learnerBody()`'s stat tiles now come from
  `learnerRealStats()` — a rollup of `learnerAssignments()`'s real
  `assignment_results`/`submissions`/`digital_learning` data, using
  `x360MetricCard` (the same "not yet tracked"-capable, no-forced-action
  tile the Kobo and legacy-sunset panels use) instead of `statTiles()`'s
  KPI-with-navigation shape, which this data doesn't fit. A confirmed-dead
  code island from an earlier version of the learner dashboard
  (`contentCard()`, `cardRow()`, `subTabs()`, and their orphaned event
  wiring — verified zero callers each) was removed alongside it.
- **One additional real gap found and fixed while wiring this up**:
  `syncResults()` was hardcoding `submissions.learner_id: null` on every
  push to Postgres, regardless of whether a real `learners.id` was
  available — meaning the FK fix above would have accomplished nothing in
  practice. Now sets it when the submitting learner is a genuinely linked
  roster entry, falls back to `null` (name-only, exactly as before)
  otherwise.
- **Tested**: real browser, a realistic `hpf_classes`-shaped roster
  (one linked learner, one deliberately unlinked) — confirmed the kiosk
  action is correctly gated per-learner, confirmed real assignment/
  assessment/resource data renders with zero fabricated content anywhere
  (`Day streak`/`Badges earned`/`Khan Academy`/etc. all absent), confirmed
  clean exit back to the teacher's own view. `node --check` clean on
  every touched file.

**Not done — still open, as scoped in §2/§3 and the recommendation**:
achievements (§"12", correctly not built — no case for them yet);
`courses` (§"4", correctly not built — no such table, by design);
`classes.school_id` (§"3"'s flagged text/FK inconsistency — unrelated to
the login model, left for its own pass); a real offline write-queue for
kiosk-mode activity (§"13" — `K_FO_OUTBOX`'s pattern is the recommended
model, not yet applied here); `learning_activity`/`kolibri_activity`/
`library_activity` producers (§"11" — still zero rows; unblocked by this
work, not populated by it).
