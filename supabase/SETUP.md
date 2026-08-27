# Connecting the HPF Portal to PostgreSQL (Supabase)

The portal currently keeps all data in the browser's `localStorage`. These steps
move it to a real PostgreSQL database hosted by Supabase, while keeping the
frontend static (it still deploys on GitHub Pages).

## What you do

1. **Create the project** — go to [supabase.com](https://supabase.com), sign in,
   and create a new project (the free tier is fine). Pick a strong database
   password and a region close to your users.

2. **Create the tables** — in the Supabase dashboard open **SQL Editor → New
   query**, then paste and **Run** each of these *in order*:

   | # | File | What it does |
   |---|------|--------------|
   | 1 | [`schema.sql`](schema.sql) | Every table, plus the baseline security rules |
   | 2 | [`patch-01-security.sql`](patch-01-security.sql) | Stops signups granting themselves `admin`, hides quiz answer keys |
   | 3 | [`patch-02-schools.sql`](patch-02-schools.sql) | `schools` table (name, county, GPS, story) + seed data |
   | 4 | [`patch-03-profile-fields.sql`](patch-03-profile-fields.sql) | `profiles.project`; stops signup dropping county & project |
   | 5 | [`patch-04-revoke-trigger-fn-execute.sql`](patch-04-revoke-trigger-fn-execute.sql) | Stops the trigger functions being callable over the REST API |
   | 6 | [`patch-05-fk-indexes.sql`](patch-05-fk-indexes.sql) | Covering indexes on all nine foreign keys |
   | 7 | [`patch-06-rls-initplan.sql`](patch-06-rls-initplan.sql) | Stops RLS policies re-running `auth.uid()` per row |
   | 8 | [`patch-07-school-returns.sql`](patch-07-school-returns.sql) | Termly returns filed by heads of institution |
   | 9 | [`patch-08-return-corrections.sql`](patch-08-return-corrections.sql) | Audit trail for corrections to a filed return |
   | 10 | [`patch-09-enrolment-by-grade.sql`](patch-09-enrolment-by-grade.sql) | Enrolment split per grade and gender |
   | 11 | [`patch-10-head-of-institution.sql`](patch-10-head-of-institution.sql) | Head of institution name, title and contact |
   | 12 | [`patch-11-open-signup.sql`](patch-11-open-signup.sql) | Auto-confirms new accounts so signup and sign-in work |
   | 13 | [`patch-12-school-officer-assignments.sql`](patch-12-school-officer-assignments.sql) | Assigns field officers to schools; scopes field report & return access to it |
   | 14 | [`patch-13-data-model-expansion.sql`](patch-13-data-model-expansion.sql) | Roles, learners, subjects, teacher/field-officer records, learning content, field visits, devices, interventions, notifications, audit trail — schema for features not built yet |
   | 15 | [`patch-14a-staff-role-enum.sql`](patch-14a-staff-role-enum.sql) | Adds the `staff` role value — must run and commit on its own, before patch-14 |
   | 16 | [`patch-14-staff-tier.sql`](patch-14-staff-tier.sql) | Splits Admin into Staff (full access) + Admin (full access, plus the exclusive power to grant Admin) |
   | 17 | [`patch-15-staff-invite.sql`](patch-15-staff-invite.sql) | `profiles.needs_password` — tracks admin-invited staff who still need to set their own password |
   | 18 | [`patch-16-admin-manage-staff.sql`](patch-16-admin-manage-staff.sql) | Only Admin can edit or remove an existing Staff/Admin row — Staff keeps inviting new ones and viewing the list |
   | 19 | [`patch-17-updated-at.sql`](patch-17-updated-at.sql) | Adds `updated_at` (+ trigger) to every mutable table that only had `created_at` |
   | 20 | [`patch-18-attendance.sql`](patch-18-attendance.sql) | `attendance_records` — per-learner, per-class, per-day attendance |
   | 21 | [`patch-19-me-indicators-targets.sql`](patch-19-me-indicators-targets.sql) | `me_indicators`, `me_indicator_values`, `me_targets` — M&E data model |
   | 22 | [`patch-20-evidence.sql`](patch-20-evidence.sql) | `evidence` — generic supporting attachment, linked to any other row |
   | 23 | [`patch-21-single-source-of-truth.sql`](patch-21-single-source-of-truth.sql) | Gives learner logins, the digital library, and scorecard activities a real database home — see [`STORAGE-AUDIT.md`](STORAGE-AUDIT.md) |
   | 24 | [`patch-22a-rbac-role-values.sql`](patch-22a-rbac-role-values.sql) | Adds `programme_manager` + `me_officer` role values — must run and commit on its own, before patch-22 |
   | 25 | [`patch-22-permission-matrix.sql`](patch-22-permission-matrix.sql) | The permission matrix (`app_modules`, `permissions`, `has_perm()`) — see [`AUTH-RBAC.md`](AUTH-RBAC.md) |
   | 26 | [`patch-23-rbac-policies.sql`](patch-23-rbac-policies.sql) | Rewrites every table's RLS as matrix-backed, per-command (view/create/edit/delete) policies |
   | 27 | [`patch-24-audit-triggers.sql`](patch-24-audit-triggers.sql) | Wires the audit trail to real triggers — it existed since patch-13 but nothing had ever called it |
   | 28 | [`patch-25-require-email-confirmation.sql`](patch-25-require-email-confirmation.sql) | Reverses patch-11's auto-confirm — **test a real signup immediately after applying** (see the patch's own header and [`AUTH-RBAC.md`](AUTH-RBAC.md)) |
   | 29 | [`patch-26-master-data.sql`](patch-26-master-data.sql) | Master Data Management fields: school code/sub-county/contact/status, a real `profiles.school_id` link, learner grade, and natural-key uniqueness constraints — see [`MDM.md`](MDM.md) |
   | 30 | [`patch-27-mdm-audit.sql`](patch-27-mdm-audit.sql) | Extends patch-24's audit triggers to `teachers`, `learners`, `field_officers` |

   **School 360** (no new migration — a read-only view over existing tables): see [`SCHOOL-360.md`](SCHOOL-360.md).
   | 31 | [`patch-28-schools-autocode.sql`](patch-28-schools-autocode.sql) | Auto-generates a school `code` when an insert doesn't supply one — fixes a real regression where the older "Add school" form (predating Master Data Management) broke once `code` became required |

   **Teacher 360** (no new migration — a read-only view over existing tables, sharing School 360's rendering helpers): see [`TEACHER-360.md`](TEACHER-360.md).

   **Do not run [`seed-dev.sql`](seed-dev.sql) against this project.** It's fake
   data for local/branch testing only — see its own header comment.

   **All of them are safe to re-run**, so if you are unsure what state the
   database is in, just run them all in order — that is the reliable way to
   reach a known-good state.

   `schema.sql` is deliberately create-only rather than create-or-replace. It
   defines the *original* `handle_new_user()`, which trusts the client's role
   and hands admin to anyone who posts `{"role":"admin"}` at signup — patch-01
   closes that. If re-running `schema.sql` replaced existing objects it would
   silently reopen the hole, so it skips anything that already exists and
   leaves your patched versions alone.

3. **Create your admin login** — dashboard → **Authentication → Users → Add
   user**. Enter an email + password and tick **Auto Confirm User**. Then in the
   SQL Editor run (with your email):

   ```sql
   update profiles set role = 'admin' where email = 'you@example.org';
   ```

   This is only needed for the **first** admin. After that, sign in to the portal
   as that admin and use **My Dashboard → Admin → HPF administrators** to create
   or promote further admins — no SQL, and the accounts work on every device.

4. **Switch on password / username recovery** — the login page's *Forgot
   password?* and *Forgot username?* need email delivery configured in the
   dashboard before they can reach anyone. See
   [`AUTH-RECOVERY.md`](AUTH-RECOVERY.md) — it is all dashboard settings, no SQL.

5. **Send me two values** — dashboard → **Project Settings → API**:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon public** key (a long token labelled `anon` / `public`)

   Both are safe to share and safe to put in the website's code — access is
   controlled by the security rules in the schema, not by keeping the key
   secret. **Do not** send the `service_role` key or the database password.

## What I do next

With those two values I will:

- Add a small `supabase.js` client to the site (loaded as an ES module, no build
  step) and a `config.js` holding your URL + anon key.
- Replace the `localStorage` data layer (`Auth`, the login repository, and all
  the class/assignment/assessment reads and writes) with Supabase calls, keeping
  the same behaviour — real sign-in with hashed passwords, live shared data
  across devices.
- Test every flow against your live database before deploying.

## Notes

- **Auth becomes real.** Today passwords sit in plain text in the browser; with
  Supabase Auth they're hashed and never exposed. Existing demo/local accounts
  won't carry over — you (or users) sign up fresh.
- **Data becomes shared.** Right now each browser has its own copy; after this,
  everyone reads and writes the same database, so a teacher's published quiz
  really does appear on a learner's own device.
- **Still static.** No server to run or maintain — the browser talks to Supabase
  directly, so GitHub Pages hosting stays exactly as it is.
