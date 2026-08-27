# Authentication & authorization — production upgrade (patch-22 through 24)

What changed, why, and how it was verified. Read alongside
[`STORAGE-AUDIT.md`](STORAGE-AUDIT.md) (session state, caching) and
[`AUTH-RECOVERY.md`](AUTH-RECOVERY.md) (password recovery, SMTP) — this
document is specifically the role/permission/audit layer.

## What was already production-grade, and untouched

The login experience, password recovery, and session handling predate this
pass and are **preserved exactly as they were**:

- Sign-in is real Supabase Auth (`signInWithPassword` / `signUp`), sessions
  are real JWTs, sign-out is `supabase.auth.signOut()`.
- Password recovery (`recovery.js`) — reset link, magic link, and the
  invite-link flow that lets an admin add someone without ever typing or
  seeing their password — is unchanged.
- Learner accounts stay local-only (`hpf_users`/`hpf_session`), a deliberate,
  documented design: no email means no Supabase Auth account means no JWT,
  and RLS is JWT-based. See `STORAGE-AUDIT.md` for the full reasoning.

Nothing below touches any of that. What was missing was **role-based
authorization with a single, auditable definition** — before this, "what can
an X do" was an answer scattered across 69 ad-hoc policy expressions, and two
roles (Programme Manager, M&E) didn't exist as distinct concepts at all.

## Roles

| Role | Enum value | What changed |
|---|---|---|
| Admin | `admin` | Unchanged — full access, the only role that can grant Admin. |
| Programme Manager | `programme_manager` | **New.** Split out of the old blanket `staff` tier: runs the programme, full operational access. |
| M&E | `me_officer` | **New.** Split out of `staff`: reads and exports everything, writes only monitoring & evaluation data and evidence. |
| Field Officer | `field_officer` | Unchanged role, now matrix-governed. |
| School Leader | `school_leader` | Unchanged role, now matrix-governed. |
| Teacher | `teacher` | Unchanged role, now matrix-governed. |
| Learner | `learner` | Unchanged — local-only, structurally outside RLS. |

`staff` still exists in the `user_role` enum — Postgres cannot drop an enum
value — but every existing `staff` row was migrated to `programme_manager`
(patch-22), it is no longer offered anywhere in the UI, and `roles.label`
now reads "HPF Staff (deprecated)" so it reads as retired rather than
overlooked if anyone finds it in a query.

**Why split staff into two roles at all:** a blanket "full access" tier
can't express "should observe the whole programme but not operate it,"
which is exactly what a monitoring & evaluation function needs. Two roles
made that distinction expressible instead of relying on M&E staff simply
not clicking the write buttons they technically had access to.

## The permission matrix

Not a design document — a table, queried live from the database that
enforces it (`select * from permissions`). `V`=view, `C`=create, `E`=edit,
`D`=delete, `X`=export, `A`=approve. `—` means no access.

| Module | Admin | Prog. Mgr | M&E | Field Officer | School Leader | Teacher | Learner |
|---|---|---|---|---|---|---|---|
| Schools | VCEDXA | VCEDXA | VX | VX | VX | V | — |
| Infrastructure | VCEDXA | VCEDXA | VX | VCEX | VEX | — | — |
| Termly returns | VCEDXA | VCEDXA | VX | VX | VCEX | — | — |
| People & roles | VCEDXA | VCEXA | VX | V | V | V | — |
| Learners | VCEDXA | VCEDXA | VX | VX | VCEX | VCEX | — |
| Classes | VCEDXA | VCEDXA | VX | V | VX | VCEDX | V |
| Coursework | VCEDXA | VCEDXA | VX | V | VX | VCEDX | VC |
| Attendance | VCEDXA | VCEDXA | VX | VX | VX | VCEX | V |
| Field operations | VCEDXA | VCEDXA | VX | VCEDX | V | — | — |
| Devices | VCEDXA | VCEDXA | VX | VCEX | VC | VC | — |
| Digital library | VCEDXA | VCEDXA | VX | VX | VX | VX | V |
| Monitoring & evaluation | VCEDXA | VCEDXA | **VCEDX** | VX | VX | V | — |
| Interventions | VCEDXA | VCEDXA | VX | VCEX | V | — | — |
| Evidence | VCEDXA | VCEDXA | **VCEDX** | VCX | VC | VC | — |
| Audit & access logs | VCEDXA | VX | VX | — | — | — | — |
| Permission matrix | VCEDXA | V | VX | V | V | V | V |

Two things worth reading directly off this table:

- **M&E's write access is exactly two rows wide** (bolded above) — everywhere
  else it's view/export only. That is the role's whole reason for existing.
- **Nobody has `create`/`edit`/`delete` on Audit & access logs** — not even
  Admin. The audit trail is append-only by construction (see below), and the
  matrix says so instead of it being an undocumented side effect.

Learner rows describe the *product*, not an RLS grant — learners hold no
Supabase session, so RLS never evaluates for them at all; these rows exist
so the matrix is a complete map of the app, not just the part with a JWT.

**Changing the matrix**: `update permissions ...` / re-run the seed block in
`patch-22-permission-matrix.sql`. Every policy reads it live via
`has_perm(module, action)` — there is no cache to invalidate and no code to
redeploy.

## How it's enforced — both halves, every table

A policy answers two questions, and **both** are required:

1. **`has_perm(module, action)`** — may this *role* do this *kind* of thing
   at all? (a lookup in the matrix)
2. **The row-scope expression** — to *this specific row*? (own class, own
   school, assigned school, own upload…)

`has_perm()` alone would let a field officer edit any school's facilities,
not just their assigned ones. The row scope alone would let a learner edit
their own school's facilities without a `learners.edit` grant at all.
Every one of the 40 tables in this schema has both, split into four
separate policies — select/insert/update/delete — because a single
`for all` policy cannot express "may view but not delete," which several
roles need (M&E is the clearest case).

**158 policies, 156 matrix-backed** (the 2 exceptions are `app_modules` and
`permissions` themselves, which have their own narrower, hand-written
policies — see `patch-22-permission-matrix.sql`).

### Role assignment is guarded, not just gated

`guard_profile_role()` (patch-22, replacing patch-14's version) runs on
every `profiles` update and decides server-side whether a role change is
allowed:

- Granting **Admin** requires being Admin.
- Touching a row that's already Admin/Staff/Programme Manager/M&E requires
  being Admin.
- Every other change requires `has_perm('people', 'edit')` — Admin or
  Programme Manager; **M&E cannot reassign roles**, matching its read-only
  standing on the People module.

A refused change is silently reverted (the row keeps its old role) — silent
to the API caller, but not to the audit trail: every attempt, allowed or
refused, is written to `audit_logs` (`role_change` / `role_change_refused`),
so "someone tried to promote themselves to Admin and was refused" is a
recorded event, not a non-event.

### Audit logging — actually wired, not just defined

`log_audit()` and `audit_logs` have existed since patch-13.
**Verified before writing patch-24: zero rows, ever** — the function was
defined but no trigger anywhere called it. Patch-24 fixes that:

- A generic `audit_row_change()` trigger, attached to `schools`,
  `school_returns`, `interventions`, `action_items`, `evidence`, `devices`,
  `device_maintenance`, and `school_officer_assignments`.
- A second version for `permissions` itself, whose primary key is
  `(role, module, action)` rather than a single `id`.
- `profiles` keeps its own more specific logger (`guard_profile_role`) since
  a role change needs old/new role recorded and can be refused, which a
  generic after-the-fact trigger can't express.
- Deliberately **not** attached to high-volume rows (`attendance_records`,
  `submissions`, the three activity tables) — auditing every attendance
  mark would swamp the log for rows already attributable via their own
  `recorded_by`/`created_by` columns.

`audit_logs` has no insert/update/delete policy at all — every row arrives
through a `SECURITY DEFINER` trigger, which bypasses RLS as its owning role.
There is no path through the REST API for anyone, including Admin, to write
or alter this table directly (verified below).

A read-only **Audit log panel** now exists in the admin dashboard (gated by
`has_perm('audit','view')`, same as the table) with a CSV export.

## Verified: cannot reach another role's data by tampering

Every scenario below was run against the **live** database inside a rolled
back transaction, impersonating a real role via
`request.jwt.claims`/`set_config` — not asserted, executed.

| # | Scenario | Result |
|---|---|---|
| 1 | Teacher reads `school_returns` directly (no `returns.view`) | 0 rows |
| 2 | Teacher at School A reads a learner registered at School B | 0 rows |
| 3 | School Leader of A reads School B's return | 0 rows |
| 4 | School Leader of A reads their own school's return | 1 row |
| 5 | School Leader of A edits School B's return **by id** | refused |
| 6 | Field Officer (assigned to A) reads School B's return | 0 rows |
| 7 | Field Officer (assigned to A) reads School A's return | 1 row |
| 8 | Field Officer files a return for an unassigned school | refused |
| 9 | M&E creates a school (matrix: view+export only) | refused |
| 10 | M&E edits a school | refused |
| 11 | M&E creates an M&E indicator (its own module) | **allowed** |
| 12 | M&E reads every school's returns (read-everywhere) | 2 rows |
| 13 | M&E reads learners at every school | 2 rows |
| 14 | M&E edits the digital library (view+export only there too) | refused |
| 15 | Teacher reads `audit_logs` | 0 rows |
| 16 | Teacher forges an `audit_logs` row directly | refused |
| 17 | **Admin** writes `audit_logs` directly (append-only by design) | refused |
| 18 | Teacher sets their own role to `admin` | reverted, still `teacher` |
| 19 | M&E sets their own role to `admin` | reverted, still `me_officer` |
| 20 | Programme Manager demotes an existing Admin | reverted, still `admin` |
| 21 | Programme Manager edits the permission matrix itself | refused |
| 22 | Anonymous (signed out / a learner's actual standing) reads `profiles` | 0 rows |
| 23 | Anonymous reads `school_returns` | 0 rows |
| 24 | Anonymous reads the **published** digital library | 4 rows (by design — learners have no session at all) |

Scenario 17 is the one worth dwelling on: **Admin cannot write the audit
trail even though Admin can do everything else.** That's the point of an
append-only log — the one role capable of doing anything to any data cannot
retroactively edit the record of what it did.

**One bug this suite caught before shipping**: the first version of the
`school_returns`/`school_return_grades`/`school_return_revisions`/
`teacher_training` view policies used `is_programme_manager()` (excludes
M&E) instead of `is_staff()` (includes M&E) on the *read* side, which
silently denied M&E the read access the matrix grants it — scenario 12
failed until that was fixed. Left in this document rather than quietly
corrected, because it's the concrete answer to "how do you know the tests
aren't just confirming what you assumed": they found a real defect.

## Frontend

Route protection, role dispatch, and the dashboard body a user sees are all
driven by the **signed-in session's actual role** (`Auth.current().role`),
never by a URL parameter or client-supplied value — there is no route like
`/dashboard?role=admin` for a client to forge. `VIEWABLE`/`CAN_ENTER`
(`dashboards.js`) additionally restrict which *other* workspaces a signed-in
user may switch into for legitimate multi-hat cases (an admin previewing
the teacher view), separately from what data those views can actually load,
which RLS still governs regardless of which tab is open.

Per the brief's own instruction, **frontend button-hiding is not treated as
enforcement** — every scenario above was proven at the database layer, with
no UI in the loop at all. The UI hides what a role cannot use (there is
limited value in showing a Delete button that RLS will refuse), but that is
convenience, and removing it would degrade the experience, not open a hole.

## Removed from production

- **`lovable-export/`** — a stale static export from an earlier prototyping
  tool, unreferenced by the real site, but published live at
  `/HPF-digital-portal-2026/lovable-export/` because the deploy workflow
  mirrors the whole repo. It embedded a hardcoded Supabase URL and anon key
  for a **different, unrelated project** (`atmttuxxqqooepbutbfo.supabase.co`)
  — exactly the kind of development-tool credential the brief asks to
  remove from a production deployment. Deleted.
- **The "Simulate" button** (teacher → assessment analytics) wrote fabricated
  learner submissions directly into the production `submissions` table to
  preview analytics. Removed entirely, along with the function that
  generated the fake rows — per your decision, rather than merely
  restricting who could click it.

No hardcoded passwords, demo accounts, or default credentials were found
anywhere reachable by the client (`ADMIN_EMAIL` is a real display-only
address the login-events inbox says mail is "delivered to," not a
credential).

## Signups now require real email confirmation (patch-25)

`patch-11-open-signup.sql` auto-confirmed every new Supabase Auth signup
(`email_confirmed_at` set immediately, no click-to-verify) — added because
SMTP delivery wasn't reliable and confirmation emails were stranding real
accounts. **Patch-25 drops that trigger.** Explicitly requested with the
lockout risk stated up front: whether an unconfirmed account can sign in is
governed by the **Authentication → Providers → Email → "Confirm email"**
toggle in the Supabase dashboard, which no migration in this repo can see
or change. If that toggle is on (patch-11's own header says it was) and
SMTP still isn't fully delivering, this reproduces the exact lockout
patch-11 existed to fix.

**Test this immediately** — sign up a fresh test account and confirm the
email actually arrives and the link works (`TESTING.md` has the manual
script) — before relying on self-serve signup in front of real users.
Verified so far: dropping the trigger touched zero existing rows (there
were no unconfirmed accounts at the time), so nothing already using the
portal is affected either way.

**Rollback** if signups start getting stranded: re-run
`patch-11-open-signup.sql` — still safe to re-run, it recreates the trigger
and releases anything currently stuck unconfirmed.

## Files

| File | Purpose |
|---|---|
| `patch-22a-rbac-role-values.sql` | Adds the two new enum values (must commit before patch-22) |
| `patch-22-permission-matrix.sql` | `app_modules`, `permissions`, `has_perm()`, migrates `staff` rows, rewrites `guard_profile_role()` |
| `patch-23-rbac-policies.sql` | Rewrites all 40 tables' RLS as matrix-backed, per-command policies |
| `patch-24-audit-triggers.sql` | Wires `log_audit()` to real triggers on 9 sensitive tables |
