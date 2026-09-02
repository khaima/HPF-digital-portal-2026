# Legacy local staff account sunset

A controlled path off `hpf_users` (localStorage) for the staff accounts
that predate Supabase Auth — built, not just planned. See
[patch-30-legacy-account-sunset.sql](patch-30-legacy-account-sunset.sql)
for the schema and [AUTH-RBAC.md](AUTH-RBAC.md) for how real Supabase
accounts already work.

## The constraint that shapes everything here

`hpf_users` has never synced off the browser that created it. The user
management panel's own header comment already says so: *"Two admins on
two laptops had two different, both-wrong pictures of who had access."*
There is no server-side census of legacy accounts to query — not a
missing feature, a structural fact about where this data has always
lived. **This sunset mechanism cannot answer "how many legacy accounts
exist" as a one-time count, and nothing built here pretends otherwise.**

What it *can* do, and does: turn "legacy account" from an invisible,
per-browser fact into a server-visible, growing ledger — populated one
real login at a time, starting the moment this shipped. The population
this reports on is **"legacy accounts that have actually logged in since
patch-30"** — the only population that was ever knowable, and arguably
the only one that matters (an account nobody has signed into in months is
already functionally retired, whether or not anyone flags it).

## Items 1–5, answered honestly

| Question asked | Answer |
|---|---|
| 1. Number of legacy accounts | **Not centrally determinable, ever — see above.** Zero were detected before this shipped (the ledger didn't exist). From today, `legacy_account_migrations` grows by one row the first time each distinct legacy account actually signs in. |
| 2. Which are still active | Defined operationally as "has a row in the ledger" — a legacy account nobody has used since this shipped will never appear, which is the correct behavior, not a gap. |
| 3. Which already have a Supabase account | Checked live, per account, at the moment it's first detected: `record_legacy_login()` looks up the identifier against `profiles.email` and lands the row as `already_has_account` instead of `detected` when it matches. Not knowable in advance; knowable the instant it's seen. |
| 4. Which can be migrated | Anything that reaches `detected` or `invited` — see the workflow below. |
| 5. Which are obsolete | An admin call, not a heuristic — the "Legacy account sunset" panel has a "Mark obsolete" action for an account nobody uses any more. |

## How it works

```
legacyLogin() succeeds (app.js — still no JWT, never will have one)
  -> record_legacy_login()         anon-callable, SECURITY DEFINER, narrow
     upserts legacy_account_migrations, keyed on lower(identifier)
  -> the SAME session shows a "Migrate now" banner immediately
  -> person confirms an email
  -> adminClient().auth.signInWithOtp({shouldCreateUser:true, ...})
     the exact call createStaffAccount() already uses for an admin-
     created invite — self-triggering it grants nothing beyond the
     ordinary self-serve role public sign-up already gets (patch-01
     clamps it either way)
  -> mark_legacy_invited()          anon-callable, SECURITY DEFINER, narrow
     flips status to 'invited', stores the confirmed email
  -> an admin, in "Legacy account sunset", sees the invited row with its
     captured role/school/county/project and clicks "Complete migration"
  -> promoteToRole() + profiles.update() — the SAME functions
     createStaffAccount() already uses, gated by the SAME
     guard_profile_role()/has_perm('people','edit') check patch-14/16
     already enforce. This is the one step that actually grants a role,
     so it's the one step that needs a real, permissioned session.
  -> complete_legacy_migration()    records the outcome atomically,
     re-checking has_perm('people','edit') itself as a second gate
  -> legacyLogin() checks is_legacy_migrated() before ever accepting a
     legacy credential again; a migrated identifier is refused, and the
     browser's own hpf_users row is flagged so it stops trying even
     offline.
```

### Why the invite step is self-service but the role grant isn't

A legacy sign-in has no JWT — that's the entire reason `legacyLogin()`
exists. `signInWithOtp({shouldCreateUser:true})` is safe to trigger from
that JWT-less session because it grants nothing beyond what public
self-serve sign-up already grants: a bare account at the self-serve role
patch-01 clamps every signup to. Setting the *real* role (teacher, school
leader, field officer, …) and school is a genuine privilege grant, and
Postgres RLS correctly refuses to let an anonymous caller do that —
`guard_profile_role()` has enforced this since patch-14, unchanged here.
So the workflow is self-service up to the point where a privilege would
actually be granted, and admin-completed from there — the one adjustment
made to the literal requested workflow, made because the alternative is a
privilege-escalation bug, not a convenience trade-off.

### Administrative migration status

Six states, `legacy_account_migrations.status`:

| Status | Meaning |
|---|---|
| `detected` | Seen once via a real legacy login. Nothing done yet. |
| `already_has_account` | The identifier already matches a real `profiles.email` — no invite needed, just tell them to sign in with that email. |
| `invited` | `signInWithOtp` sent; `confirmed_email` captured. Waiting on an admin. |
| `migrated` | Role, school, county, project restored on a real Supabase account. `migrated_profile_id` set. |
| `declined` | An admin marked this account as intentionally not migrating. |
| `obsolete` | An admin marked this account as no longer in use. |

Visible (and actionable) in the admin dashboard's **"Legacy account
sunset"** panel, next to User management — same load/cache/render/wire
shape as every other admin panel in `dashboards.js` (see `koboPipelinePanel`
for the closest sibling).

### Sunset date/configuration

`legacy_sunset_config` — one row, admin-editable `sunset_date` + a free-text
`note`. Purely a displayed target; nothing in this schema enforces it
automatically. Reaching it is a signal for a human decision, not a trigger
for automatic deletion — see the next section.

## What happens when the legacy account count reaches zero

**Nothing, automatically — by design, per the explicit instruction not to
delete the legacy system immediately.** The admin panel shows a clear
banner once every detected account has left the `detected`/`invited`
state ("Zero legacy accounts remaining out of N detected — the legacy
sign-in path can now be considered for removal"), but reaching zero is a
prompt for a **separate, explicit, future request**, not something this
patch or its code acts on by itself.

When that request comes, removal is exactly the three items already named:

1. **`legacyLogin()`** (app.js) — and its two call sites in `Auth.login()`.
2. **`userManagementPanel()`**'s local-account branch (dashboards.js) — the
   `directoryUsers()` local-row mapping and `LOCAL_ONLY_ROLE` handling for
   anything that isn't a learner. (`userManagementPanel()` itself stays —
   it already reads `profiles` as the source of truth for every role; only
   the legacy-local sliver goes.)
3. **`hpf_users` staff authentication** — the `K_USERS` array stops being
   read for anything except learners.

**Learner accounts are explicitly untouched by any of this**, now or at
that future removal — `LOCAL_ONLY_ROLE = "learner"`, `registerLearner()`,
and the learner local-login path are a separate product decision, per the
instruction, and nothing in patch-30 or this document changes how they
work.

## What patch-30 does NOT do

- Does not remove `legacyLogin()`, `userManagementPanel()`, or `hpf_users`.
- Does not touch learner accounts or their local storage in any way.
- Never reads, stores, or transmits a legacy account's plaintext password.
  The new account's password is set exactly once, by the person
  themselves, via Supabase's own emailed link — nobody (not this patch,
  not an admin) ever sees or types it. The legacy plaintext password
  already sitting in `hpf_users` is a pre-existing condition this patch
  does not make worse and does not attempt to "fix" — the whole point is
  retiring that storage, not hardening it.
- Does not invent a sunset date — `legacy_sunset_config.sunset_date`
  starts `null`; an admin sets it.

## Testing performed (2026-09-01)

- **SQL, rolled back, zero residue** (verified via row counts before and
  after): `record_legacy_login`'s upsert/refresh/idempotency logic, the
  `already_has_account` short-circuit against a real `profiles.email`,
  `learner`/invalid-role rejection, `mark_legacy_invited`'s idempotency,
  `complete_legacy_migration`'s internal `has_perm('people','edit')` gate
  — confirmed refused for a real `field_officer`-role profile and
  confirmed to succeed and atomically flip `status` for a real
  `admin`-role profile — and the direct-`UPDATE` RLS policy refusing the
  same non-privileged actor (0 rows affected).
- **Real browser, real network calls, real (then deleted) database row**:
  seeded a synthetic legacy account into `hpf_users`, submitted the actual
  login form. Confirmed, via a captured `fetch` log: `is_legacy_migrated`
  called first, `record_legacy_login` called on success with the correct
  identifier/role/school/county, a real row landed in
  `legacy_account_migrations`, the "Migrate now" banner rendered on the
  resulting dashboard, `login_count` incremented correctly on a second
  login, and a wrong password produced **zero** network calls (confirming
  detection only ever fires on a real, verified credential match). The
  test row was deleted afterward — production tables are back to their
  pre-test state (0 rows).
- **Admin panel**: confirmed the "Legacy account sunset" panel's queries
  fire with the correct table/column shapes (mocked-session technique,
  same limitation as every other admin panel this session — a fabricated
  JWT can prove the request shape but not render real authenticated data;
  see `KOBO-INTEGRATION.md`'s equivalent note).
- `node --check` on both edited files.
- `get_advisors` (security) after the migration: only the same
  by-design `anon`/`authenticated`-executable `SECURITY DEFINER` warning
  every existing helper in this schema already carries (`is_admin`,
  `has_perm`, `record_local_login`, …) — no new class of finding.
