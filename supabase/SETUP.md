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

   The patches are safe to re-run, so it does no harm to apply one twice. Run
   them in order though — each builds on the last.

3. **Create your admin login** — dashboard → **Authentication → Users → Add
   user**. Enter an email + password and tick **Auto Confirm User**. Then in the
   SQL Editor run (with your email):

   ```sql
   update profiles set role = 'admin' where email = 'you@example.org';
   ```

4. **Send me two values** — dashboard → **Project Settings → API**:
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
