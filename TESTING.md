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
