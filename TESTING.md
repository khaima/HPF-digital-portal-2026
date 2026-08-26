# Manual test scripts

Tests that need a live Supabase project and a real inbox — nothing here runs
in CI. Each script says exactly what to do and exactly what "passed" looks
like, so it doesn't need Supabase or auth-flow familiarity to run.

## Password reset actually delivers, to a real outside address

**What this proves:** real SMTP (`supabase/AUTH-RECOVERY.md`, step 3) is
genuinely configured and working — not just reachable for addresses inside
your own Supabase organisation, which the built-in development mailer already
delivers to for free and would make this look done when it isn't.

**Needs:** an email address that is **not** a member of the Supabase
organisation this project lives in — a personal Gmail/Outlook address, or any
inbox you can open that isn't `@humanpractice.org` (or whatever domain your
Supabase team uses). Using a staff address here does not test the thing this
test exists to test.

**Steps:**

1. Open the portal and go to **Login → Forgot password?**
2. Enter the outside email address from above.
3. Click **Email me a reset link**.
4. Open that address's actual inbox (not the Supabase dashboard) and wait —
   give it a couple of minutes; do not refresh the portal while waiting.
5. Open the email when it arrives.

**Pass looks like:**

- [ ] The email arrives within a few minutes, in the inbox or promotions tab —
      not spam/junk (if it's in spam, step 3's domain verification, SPF/DKIM,
      needs another look).
- [ ] The email contains a working **link**. Clicking it opens the portal on
      the "choose a new password" screen, not the home page (if it lands on
      the home page, the redirect URL from step 1 is missing).
- [ ] The email also contains a visible **6-digit code**, separate from the
      link, in plain text you could read aloud (if there's a link but no
      code, step 2's template edit didn't take).
- [ ] Setting a new password from the link works, and the next sign-in with
      the new password succeeds immediately.

**If it fails:** check **Authentication → Logs** in the Supabase dashboard
first — it shows every send attempt and why one failed, and is faster than
guessing between "didn't send" and "sent but landed in spam."

**Note:** this address has no HPF account, so nothing here should imply one
was created — the portal intentionally sends the same reset email whether or
not the address is registered, so this test doesn't accidentally register
one. Confirming that specific behaviour is a separate check, not this one:
enter an address you're certain has no account and confirm the portal's
response gives no sign either way.

## Signup confirmation actually delivers, to a real outside address

**What this proves:** with *Confirm email* switched on (`AUTH-RECOVERY.md`
step 0, decided to happen once step 3 is live), a brand-new signup's
confirmation email — link and code both — genuinely reaches an inbox outside
your Supabase organisation, not just the built-in dev mailer's free delivery
to your own team's addresses.

**Needs:** an outside email address (same rule as above), not already used
for any HPF account.

**Steps:**

1. Portal → **Login → Sign up**, fill the form as a Teacher, using the
   outside address.
2. Submit. You should land on **Confirm your email**, not a dashboard.
3. Open that address's real inbox and wait a couple of minutes.

**Pass looks like:**

- [ ] The email arrives within a few minutes, not in spam.
- [ ] It contains a working **link** — opening it signs the account in and
      lands on the dashboard.
- [ ] It also contains a visible **6-digit code** — typing it into the
      **Confirm your email** panel (without using the link) does the same.
- [ ] Signing out and back in with the new password works immediately,
      without hitting the confirmation panel again.

**If it fails:** same first move as above — **Authentication → Logs**.

## Forgot username delivers, to a real outside address

**What this proves:** the same real-SMTP requirement, for the sign-in-by-code
path specifically (`signInWithOtp`, not `resetPasswordForEmail` — a
different Supabase call, worth confirming separately rather than assuming
one working flow means both do).

**Needs:** an existing HPF account whose email is an outside address — reuse
the account created in the signup test above, or any other non-org account
already on the portal.

**Steps:**

1. **Login → Forgot password? → Forgot username?** tab.
2. Enter that account's email → **Email me a sign-in code**.
3. Open the real inbox and wait.

**Pass looks like:**

- [ ] A **6-digit code** arrives within a few minutes, not in spam.
- [ ] Typing it into the portal signs the account in and reveals the
      username on file (or "none set" if it never had one — still a pass,
      that's the honest state for an account created without a username).

## Staff invitation delivers, to a real outside address

**What this proves:** `createStaffAccount()`'s invite (`dashboards.js`,
`signInWithOtp` with `shouldCreateUser: true`) reaches a real inbox and the
forced "choose your password" step (`patch-15`'s `needs_password`) actually
gates first sign-in — the specific thing this flow exists to guarantee,
since nobody types a password into the admin panel for this account any more.

**Needs:** an Admin or Staff session on the real portal, and an outside email
address with no existing HPF account (an invite to an address that already
has one is refused by the form itself, on purpose).

**Steps:**

1. Sign in as Staff or Admin → **HPF Staff & Admins → Add staff member**.
2. Enter a name and the outside `@humanpractice.org` address (the form
   requires the org domain — use a real HPF-owned inbox you can check, not a
   personal one, since this step specifically needs an `@humanpractice.org`
   address rather than any outside one).
3. **Send invite**.
4. Open that inbox and wait.

**Pass looks like:**

- [ ] The invite email arrives within a few minutes, not in spam.
- [ ] Opening its link signs the account in and lands on **Welcome to the
      HPF portal — choose a password to finish**, not a dashboard directly —
      if it skips straight to a dashboard, `needs_password` didn't get set
      and step 15's ordering fix needs a second look.
- [ ] Setting a password there works, and lands on the Staff dashboard.
- [ ] Signing out and back in with that password (no confirmation step this
      time) reaches the dashboard directly.

**If it fails:** **Authentication → Logs** first, same as every other flow
here. If the email arrives but the account lands straight on a dashboard
instead of the password step, that's a code issue, not an email one — worth
reporting back rather than re-testing SMTP.
