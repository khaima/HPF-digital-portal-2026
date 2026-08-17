# Letting people sign in, sign up, and recover their accounts

The portal now handles **Forgot password?**, **Forgot username?**, and **new
signups that need email confirmation** on the login page. The code is done; the
flows only deliver once the Supabase project is configured to send the emails.
That is all dashboard work — no SQL to run.

**If you only do one thing, do [step 0](#0-decide-whether-new-signups-must-confirm-their-email).**
Right now every new account is created but cannot sign in until its address is
confirmed, and confirmation emails aren't being delivered — so nobody but you
can get in.

Everything below is in your project at
<https://supabase.com/dashboard/project/zptupvyrwoeabncxabgj>.

## 0. Decide whether new signups must confirm their email

**Authentication → Sign In / Providers → Email → Confirm email**

It is currently **on**. That means `signUp()` creates the account but returns no
session: the person is registered and locked out at the same time, and they stay
locked out until they open a confirmation email — which, until step 3 below is
done, never arrives.

| | Confirm email **off** | Confirm email **on** |
|---|---|---|
| New teacher signs up | signed in immediately, no email needed | must open the emailed link or type the code |
| Depends on email delivery | no | yes — step 3 is mandatory |
| Stops someone signing up with a colleague's address | no | yes |

**Switching it off is the fastest way to open the portal to your staff**, and it
is a reasonable choice for a portal where accounts are handed out inside a known
organisation. Switching it on later costs nothing — existing accounts stay
confirmed.

Either way the portal now behaves properly: when Supabase withholds the session,
the login page shows a **Confirm your email** panel that takes the emailed link
or the 6-digit code, with a resend button, instead of the old dead-end error. The
same panel appears if someone tries to sign in before confirming.

**Confirming somebody by hand** (the escape hatch when email isn't set up):
**Authentication → Users**, click the person, then use the confirm action on
their row. They can sign in the moment it's done.

## 1. Allow the portal's return address (required)

**Authentication → URL Configuration**

| Field | Value |
|---|---|
| Site URL | `https://khaima.github.io/HPF-digital-portal-2026` |
| Redirect URLs | `https://khaima.github.io/HPF-digital-portal-2026/auth` |

Add `http://localhost:5173/auth` to Redirect URLs as well if you test locally.

Supabase silently ignores a return address that isn't on this list and dumps
people on the Site URL instead, so a reset link that lands on the home page
rather than the "choose a new password" screen means this step is missing.

## 2. Put the code in the emails (required for the code option)

Supabase's stock templates only contain a link. The portal offers a 6-digit code
as well, for anyone reading mail on a different phone from the one they're
signing in on, so both templates need the token added.

**Authentication → Emails → Templates**

- **Reset Password** — used by *Forgot password?*
- **Magic Link** — used by *Forgot username?*
- **Confirm signup** — used by new signups (skip this one if you turned
  *Confirm email* off in step 0)

Keep whatever the template already has and add:

```html
<p>Or enter this code in the portal: <strong>{{ .Token }}</strong></p>
<p>It expires in one hour and can only be used once.</p>
```

Leave `{{ .ConfirmationURL }}` in place — the link and the code are two ways
through the same email, and the portal supports both.

## 3. Set up real email sending (required before anyone but you can use it)

**This is the step that decides whether teachers actually receive anything.**

The built-in email service is for development only: it sends **at most a couple
of messages an hour**, and only to addresses belonging to your Supabase
organisation. A teacher who asks for a reset simply never gets an email, and
nothing in the portal or the dashboard says why.

Fix it under **Project Settings → Authentication → SMTP Settings**: switch on
custom SMTP and point it at whatever sends HPF's mail (Google Workspace,
Microsoft 365, Resend, Brevo, Mailgun…). Use a sender address on a domain you
control — `no-reply@humanpractice.org` — or the mail lands in spam.

Then raise the ceiling under **Authentication → Rate Limits**, which still
defaults to the development limit after SMTP is configured. Something like 30
emails/hour suits a few hundred staff; you can raise it later.

## 4. Check it end to end

**A new person signing up**

1. Portal → **Login → Sign up**, fill in the form as a Teacher.
2. With *Confirm email* **off**: they are signed in on the spot and land on their
   dashboard. Done — that is the whole flow.
3. With *Confirm email* **on**: they land on **Confirm your email**. Opening the
   link from the email signs them in; typing the code from the same email does
   the same thing without leaving the page.
4. Sign out, sign back in with the same email and password: they go straight to
   their dashboard, and stay signed in across a refresh.

**Recovering an account**

1. **Login → Forgot password?** → enter a real staff email → **Email me a reset
   link**. Open it on the same device: you get the "choose a new password" form,
   and the new password works immediately.
2. Repeat with **Send a 6-digit code instead** and type the code from the email.
3. **Forgot username?** — after the code, the portal shows the username on the
   account.

**Authentication → Logs** shows every send and every failure, and is the first
place to look when an email doesn't arrive.

## What the portal does and doesn't do

- **Nothing is emailed to an unregistered address.** Ask to recover an address
  with no account and the portal behaves exactly as it does for a real one — it
  won't confirm or deny that an account exists, so the login page can't be used
  to harvest who works for HPF. The dashboard logs show the truth.
- **A username is never emailed.** The email carries only a link or a code;
  the username appears in the portal after the code is accepted. Emailing it
  would hand it to anyone who can read the mailbox without proving they can.
- **Codes and links last one hour** and work once. Both are adjustable under
  Authentication → Providers → Email (Email OTP Expiration).
- **Learner accounts cannot be recovered this way.** Learners sign up with a
  username and no email address, so there is nowhere to send anything; their
  teacher or school leader resets them from the dashboard. The recovery panel
  says so.
- **Backing out signs you out.** "Back to login" after a code or link has been
  accepted drops the temporary session rather than leaving someone half-way in.
- **A signed-in visitor never sees the login page.** Opening `/auth` with a live
  session lands you on your own workspace instead — which is also how a
  confirmation link, which arrives back at `/auth`, ends up on your dashboard.
- **A registered-but-unconfirmed account is not a failed signup.** The account
  exists in `auth.users` from the moment the form is submitted. Signing up again
  with the same address will not create a second one; confirm the first instead
  (by email, or by hand in the dashboard).

## If something goes wrong

| What you see | Cause |
|---|---|
| Link opens the home page, not the password form | `/auth` is missing from Redirect URLs (step 1) |
| Email has a link but no code | `{{ .Token }}` missing from the template (step 2) |
| No email at all, for a real account | Built-in mailer — hourly cap reached, or the address isn't in your Supabase org (step 3) |
| "Too many emails have been sent…" | Rate limit reached; raise it or wait the hour out (step 3) |
| "That code is wrong or has expired" | Mistyped, already used, or over an hour old — send a new one |
| "Your reset link is no longer valid" | The reset session expired before the new password was saved; start again |
| Signup ends on "Confirm your email" and no email arrives | *Confirm email* is on and delivery isn't set up — do step 0 or step 3, or confirm them by hand |
| "This email address hasn't been confirmed yet" on sign-in | Same cause; the panel that appears will resend or take a code |

## Learners are different

Learners sign up with a **username and no email address**, so none of the above
applies to them: their accounts live in the browser they were created in, not in
Postgres, and they cannot sign in on a second device or recover anything by
email. A teacher or school leader resets them from the dashboard.

Giving learners real database accounts is a separate change — it needs a stand-in
email per learner and a review of the RLS policies, all of which are granted `to
authenticated` today.
