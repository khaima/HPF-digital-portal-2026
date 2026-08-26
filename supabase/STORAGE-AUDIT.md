# Browser storage audit — what lives where, and why

Every `localStorage` / `sessionStorage` key the portal writes, classified, with
the migration each one needed. The rule this audit enforces: **one
authoritative source of truth per piece of data.** Where the browser was the
only copy of something other people needed to see, it moved to Postgres.
Where the browser is genuinely the right home, it stayed — and this document
says why, so the next reader doesn't have to re-derive it.

Categories used throughout:

| | Category | Means |
|---|---|---|
| **A** | UI preference | Cosmetic, per-person, per-device. Losing it costs nothing. |
| **B** | Temporary cache | A copy of something Postgres already owns. Safe to delete; rebuilt on next load. |
| **C** | Auth / session state | Who is signed in. Belongs in the browser by definition. |
| **D** | Offline queue | Written offline, drained to Postgres when a connection returns. |
| **E** | Authoritative data | The only copy. **Must not be in localStorage** — moved. |

---

## Findings

| Key | Was | Now | What changed |
|---|---|---|---|
| `sb-<project>-auth-token` | C | C | Supabase's own session token. Untouched. |
| `hpf_session` | C | C | The signed-in local learner / legacy account. Untouched — see *Why learners stay local*. |
| `hpf_impersonate` | C | C | Holds the real admin while they're inside another account. Untouched. |
| `hpf_users` | **E** (staff too) | C, learners only | **Fixed.** Was a shadow user directory. See below. |
| `hpf_login_events` | **E** (learner logins) | B | **Migrated** to `login_events` via `record_local_login()`. |
| `hpf_library` | **E** | — (removed) | **Migrated** to `digital_learning`. |
| `hpf_activities` | **E** | — (removed) | **Migrated** to `me_indicators` + `me_indicator_values`. |
| `hpf_classes` | B + C | B + C | Kept, deliberately. See *Why classes stay local*. |
| `hpf_fo_outbox` | D | D | Kept — already a correct offline queue. |
| `hpf_return_draft` | B | B | Kept — a half-typed form, cleared on submit. |
| `hpf_chart_titles` | — | — (removed) | Dead code: declared, never read. |
| `hpf_custom_charts` | — | — (removed) | Dead code: declared, never read. |
| `hpf_recovery_intent` (sessionStorage) | A | A | Which recovery flow the user started, for one tab, for one minute. |

---

## The four that moved

### 1. `hpf_users` — users and role information

**The problem.** The admin *User management* panel treated a browser-local
array as the user directory. It was not one. It listed only the accounts
created in that browser, and its edit form could set any row's `role` to
`admin` — a change no database check ever saw, because the row had no
database counterpart. Two admins on two laptops had two different pictures of
who had access, both wrong. It also rendered every stored password in a table
column behind a show/hide toggle.

**The fix.** `profiles` is now the source of truth for every account that can
hold a session. The panel reads it, the edit form writes to it, and the role
select no longer offers a role the database would refuse silently. Creating a
teacher / school leader / field officer sends a real invite email
(`createStaffAccount`, generalised beyond staff) and the person sets their own
password — no password is typed by an admin, and none is displayed anywhere.
Removing someone demotes their `profiles.role`; the browser cannot delete an
auth user, and the code says so rather than pretending.

**What stayed.** Learner rows. A learner has no email address, so no Supabase
Auth account, so no JWT — and every RLS policy is granted `to authenticated`.
They *structurally* cannot live in `profiles`. Those rows are now labelled
**This device** in the table, next to **Database** for everyone else, so the
distinction is visible instead of implied.

**Verified:** a row planted in `hpf_users` with `role: "admin"` does not appear
in the panel, is not counted in the role tally, and cannot be created through
any form in it.

### 2. `hpf_login_events` — login requests

**The problem.** `login_events` (Postgres) has an insert policy of `to
authenticated`. A learner has no JWT and so could never satisfy it, and their
sign-ins were written only to the browser they happened in. The admin's
*Logins this week* chart merged the Postgres rows with whatever happened to be
in the admin's own localStorage — counting local sign-ins on the admin's
device and none from anywhere else.

**The fix.** `patch-21` adds `record_local_login()`, a `SECURITY DEFINER`
function callable by `anon`. It is deliberately narrow: it decides every
security-relevant field itself. The caller cannot choose a role (hardcoded
`learner`, so it can never fabricate an admin sign-in), cannot set `source`
(hardcoded `local`), cannot write an unbounded string, and cannot read
anything back — `login_events` SELECT is still `is_staff()`-only. A new
`source` column distinguishes the two kinds of row rather than blending them.
`Repo.allEvents` now reads Postgres alone; merging would have double-counted
the local device and under-counted every other one.

**Verified end-to-end, no mocks:** the real browser called the RPC with the
real anon key → the row appeared in Postgres with `role='learner'`,
`source='local'` → an admin's own query returned it → the same anon read was
refused, returning zero rows.

### 3. `hpf_library` — the Digital Library

**The problem.** A resource an admin published was visible only in the browser
that published it. `digital_learning` existed in Postgres but nothing read or
wrote it. Each browser also seeded itself its own private copy of the four
starter resources from `data.js`.

**The fix.** The panel reads and writes `digital_learning`. The four starter
resources are real HPF reference data, so they moved into the patch sequence
(alongside patch-02's schools), seeded once into the database rather than once
per browser. `patch-21` adds `file_name` and `updated_at`.

Two details worth knowing:

- **Uploads.** A small upload is still a `data:` URL, now stored in the `url`
  column. The list query deliberately *excludes* `url`, because selecting up
  to 800 KB per row on every dashboard render would be a real cost;
  `openResource()` fetches the one row's href on demand.
- **Sharing to a class** stores only a reference (`libId`), never a copy of
  the href. An admin re-pointing or unpublishing a resource now takes effect
  everywhere it was shared, instead of leaving stale copies behind.

**Verified end-to-end, no mocks:** with `localStorage` empty and `fetch`
unpatched, a page reload read the catalogue from Postgres and rendered it —
including in the learner view, which has no JWT at all (the read policy admits
`anon` for published rows).

### 4. `hpf_activities` — scorecard activities feeding pillar scores

**The problem.** The worst of the four, because it was invisible. Admin-added
activities are averaged into an **org-wide** pillar score. Stored per browser,
two admins saw two different org-wide numbers with nothing on screen to
explain the difference.

**The fix.** They are M&E indicators, so they became `me_indicators` rows with
their current score in `me_indicator_values`. `patch-21` adds
`scorecard_pillar`: the scorecard's four pillars (`education`,
`infrastructure`, `mep`, `ict`) are a finer set than `me_indicators.pillar`'s
coarse M&E vocabulary, and collapsing one into the other would be lossy —
`ict` and `general` are not the same claim — so the scorecard pillar gets its
own column rather than being forced into the existing one.

**A constraint worth recording.** `me_indicator_values` is unique on
`(indicator_id, school_id, period_year, period_term)` — one value per
indicator per period. An org-wide row has nulls in two of those four columns,
and Postgres treats nulls as *distinct* in a unique index, so appending a
second row for the same period would have been silently accepted, against the
constraint's whole intent, leaving the displayed value decided by a
`created_at` tiebreak. Editing a score therefore **updates** that period's
row. History still accrues the way the schema means it to: a new year or term
is a new row.

This was caught by testing rather than assumed — the first implementation
appended, and a rolled-back transaction against the live database showed two
rows for one period with the *older* value winning the tiebreak.

---

## The three that stayed, and why

### Why learners stay local (`hpf_users`, `hpf_session`)

RLS is JWT-based. A JWT comes from Supabase Auth. Supabase Auth requires an
email address. A learner in this programme has no email address. There is no
arrangement of these facts in which a learner row belongs in `profiles` —
it isn't a migration that hasn't happened yet, it's a property of the model.

What this costs, stated plainly: a learner's account works on one device.
That is a real limitation, visible in the UI (**This device**), not hidden.
Changing it means giving learners real identities — a product decision, not a
storage one.

### Why classes stay local (`hpf_classes`)

`hpf_classes` is a two-way cache, not a second database, and it is
load-bearing for a reason that will not go away:

- `loadClasses()` fetches class / roster / assignment / assessment shells from
  Postgres and merges them onto the local object.
- `syncResults()` pushes locally-recorded results and submissions up through
  the **teacher's** session — the shared-device model, where a learner takes a
  quiz in the teacher's browser. Both tables' RLS policies already carve out
  for exactly this (`owns_class(...)` alongside `learner_id = auth.uid()`).
- Learner render paths (`learnerAssignments()`, `liveSessionsFor()`) read it
  directly because a learner has no JWT and cannot query Postgres at all.

Postgres remains authoritative: every class, enrollment, assignment,
assessment and submission has a real row, and `_syncedId` marks what has made
it up so a second sync never double-inserts.

**The known gap**, recorded rather than papered over: a result belonging to a
learner enrolled through the older local-only path has no matching
`enrollments` row, so inserting it would violate a foreign key. Those stay
local. Closing that means back-filling `enrollments` for those learners — a
separate piece of work, not this one.

### Why the outbox is already right (`hpf_fo_outbox`)

Field reports go straight to `field_reports`; only a genuine connectivity
failure queues (`foReportIsConnectivityFailure` distinguishes "never reached
the server" from "the server said no"). The queue drains on page mount and on
the `online` event. A report Postgres *refuses* — an RLS or auth error, which
retrying cannot fix — is kept, flagged with the reason, and shown in the
officer's own list with a **blocked** pill rather than sitting forever
mislabelled as pending. No change needed.

---

## Every write has a read path

The audit's other requirement. Per store, the create/update path and the
query that reads it back:

| Store | Write | Read |
|---|---|---|
| Accounts | `profiles` insert via invite / update | `loadProfiles()` |
| Login events | `record_local_login()` RPC / `login_events` insert | `Repo.allEvents()` |
| Library | `digital_learning` insert / update / delete | `loadLibrary()`, `openResource()` |
| Scorecard activities | `me_indicators` + `me_indicator_values` | `loadMeIndicators()` → `getActivities()` |
| Field reports | `field_reports` insert (direct or via outbox) | `loadFieldReports()` |
| Classes & coursework | `classes` / `enrollments` / `assignment_results` / `submissions` | `loadClasses()` |

---

## What this audit did not change

- **Learner passwords are still stored in plain text in `hpf_users`.** They
  are no longer *displayed* anywhere, but they are not hashed. Hashing them
  client-side would be security theatre — anything the browser can compute,
  the browser can replay. The real fix is real identities for learners, which
  is the same product decision as above.
- **`school_returns.attendance_rate`** is still a typed-in figure, not
  computed from `attendance_records`. Both are real Postgres columns, so this
  is a derivation question, not a storage one.
- **No dashboard redesign.** The panels look the same; what changed is where
  their data comes from.
