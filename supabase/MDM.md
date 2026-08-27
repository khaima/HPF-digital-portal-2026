# Master Data Management

Six modules — Schools, Teachers, Learners, School Leaders, Devices,
Infrastructure — each a real search/filter/sort/paginate/create/edit/view/
archive surface over Postgres. Everything here reads and writes Supabase
directly; `data.js` is never the source of a record. The two exceptions are
`COUNTIES` (all 47 Kenyan counties) and a fixed grade-label list for
Learners' dropdown — reference enumerations for a `<select>`, not data
about any actual school, person, or device.

One generic engine (`dashboards.js`, "Master Data Management" section)
drives all six — a config object per module supplies the query, columns,
form fields, validation, and duplicate check; the search box, filter
selects, sort, pagination, and CRUD modal are shared code. Reached from the
admin dashboard, above the older single-purpose panels (Devices, People
detail, School facilities) that predate it — those still work and still
read the same tables; this is the one screen with the full feature set
across every module.

## Every record has a permanent ID

Already true everywhere before this pass — `id uuid primary key default
gen_random_uuid()` on every table involved. Nothing here changed IDs;
patch-26 only added fields and constraints to tables that already had one.
Infrastructure's identity is `school_id` (its primary key — one row per
school, see below), not a separate `id` column, and the UI's row-key
logic accounts for that explicitly rather than assuming `id` everywhere.

## Schools

| Field | Column | Notes |
|---|---|---|
| Name | `name` | required |
| School code | `code` | required, **unique**, auto-generated for the 17 schools that predate this (`COUNTY-001` style) |
| County | `county` | required, from Kenya's 47 counties |
| Sub-county | `sub_county` | optional |
| Location | `location` | free-text landmark/address |
| GPS | `lat`, `lng` | validated to real coordinate ranges |
| Programme status | `programme_status` | prospective / active / paused / graduated / closed |
| Contact | `contact_name`, `contact_phone`, `contact_email` | |
| Active/inactive | `active` | the archive flag — see below |

**Duplicate detection**: exact match on `code` (also a hard DB constraint —
the check just gives a friendlier message before the insert fails), plus a
fuzzy warning when another school in the *same county* shares the first
word of the name. Either way it's a warning, not a block — two schools can
legitimately share a name.

## Teachers & School Leaders

Both are `profiles` rows (`role = 'teacher'` / `'school_leader'`), not a
separate table — Teachers additionally extend into `teachers` (TSC number,
subject, employment type), School Leaders' extra fields (title, phone)
already lived directly on `profiles`.

**"Create" sends a real invite**, reusing the same `createStaffAccount()`
path the RBAC pass built for Staff/M&E: an email with a link to set a
password, never a password typed or shown by an admin. The school link and
role-specific fields are saved immediately after.

**The school link is written twice, on purpose.** `profiles.school_id`
(patch-26, a real foreign key) is what this module and any future feature
should query. `profiles.school` (free text) is what roughly a dozen
*existing* RLS policies still match a school leader's or teacher's own
school against — rewriting those was out of scope for master data
management, so this module keeps both in sync instead: picking a school
here sets the FK and writes that school's name into the text field, so a
person linked through this screen gets the same scoping a hand-typed
signup already relied on.

**Duplicate detection**: an existing account already using the entered
email (only checked on create — see below).

## Learners

Plain `learners` rows — `school_id` (already a real FK before this pass)
plus the new `grade` field. No auth account, structurally: see
`STORAGE-AUDIT.md`/`SCHEMA.md` on why a learner can never hold one.

**Duplicate detection**: same full name at the same school, and — if an
admission number is entered — the same admission number at the same school
(also a hard DB constraint, unique *per school*, since two different
schools legitimately reusing "001" is normal).

## Devices

Already had `school_id`, `device_type`, `serial_number`, `asset_tag`,
`status`. Patch-26 adds real uniqueness on `serial_number` and `asset_tag`
— genuine natural keys (manufacturer- and HPF-assigned respectively), not a
fuzzy guess the way a person's name would be.

**Archive** reuses the existing `status` values rather than adding a new
flag: archiving sets `status = 'retired'`.

## Infrastructure

Not a new table — `school_facilities`, already one row per school
(`PRIMARY KEY (school_id)`), which is a stronger duplicate guarantee than
any UI check could add. The list is driven from `schools` left-joined to
that row, so a school with nothing recorded yet still appears, showing
"Not recorded yet" rather than being invisible.

**No separate "New."** Every school is already a row in this list; clicking
**Edit** on an unrecorded one creates its facilities row via `upsert`. **No
archive**, either — a 1:1 current-state profile has no "old version" to
retire; **Reset** deletes the row outright so it goes back to unrecorded,
which is not the "historical programme record" the no-permanent-delete
rule is protecting (that's `school_return_revisions`, `audit_logs`, and
the like — genuine history, none of which this module touches).

## Archiving, everywhere else

"Archive" flips a status flag; nothing this module does is ever a
`DELETE`. Concretely: `schools.active` / `learners.active` /
`profiles.active` → `false`, or `devices.status` → `'retired'`. Restoring
reverses the same flag. `profiles.active` is an MDM roster flag only — it
does not gate sign-in, RLS, or any role check; a person's account keeps
working exactly as before regardless of this value, per "do not
permanently delete... unless explicitly authorized" applied to people
records without turning it into an access-control feature nobody asked
for.

## Authorization

Every module maps to a permission-matrix module from the RBAC pass
(`schools`, `people`, `learners`, `devices`, `infrastructure` —
`AUTH-RBAC.md`). The buttons this screen shows are convenience: Admin and
Programme Manager see create/edit/archive controls, M&E does not (its grant
on every one of these modules is view+export only) — but that check is a
client-side `if`, and the database's own `has_perm()` policies are what
actually refuse the write if it were ever wrong or bypassed, same as
everywhere else in this schema.

## Audit trail

`schools`, `devices`, `teachers`, `learners`, and `field_officers` all have
the generic audit trigger from patch-24/27 — every create, edit, and
archive made through this module is a row in `audit_logs`, visible in the
Audit log panel already shipped with the RBAC pass.

## Known regression, fixed (patch-28)

Making `schools.code` required (patch-26) broke the *older* "Add school"
form on the admin Schools map — it predates Master Data Management and
inserts `{name, county, lat, lng}` with no code at all, so every save
through it failed outright. Rather than patch that one call site and hope
every other insert path remembers to supply a code, `schools` now
generates one itself (patch-28) whenever an insert doesn't provide one,
using the same county-prefix scheme patch-26's backfill used. A caller
that does supply a code — Master Data Management's own form — is
unaffected.

## Resilience

A panel's own bug should cost that panel, not the whole admin dashboard.
Every panel added this session (Master Data Management, Interventions,
Audit log) renders and wires through `safeRender()`/`safeWire()`, which
catch an exception and show "couldn't load" for that one panel instead of
letting it propagate out of `adminBody()` and abort every button on the
page from getting a listener at all — the actual failure mode a stray
undefined-variable reference caused, briefly, in production during this
build. Older, long-stable panels were left as plain calls rather than
retrofitted for a risk they haven't shown.

## Files

| File | Purpose |
|---|---|
| `patch-26-master-data.sql` | Schools/profiles/learners/teachers/devices fields and constraints |
| `patch-27-mdm-audit.sql` | Extends audit logging to teachers, learners, field_officers |
| `patch-28-schools-autocode.sql` | Auto-generates a school code on insert when one isn't supplied |
