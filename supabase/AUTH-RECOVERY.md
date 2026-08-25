# Letting people sign in, sign up, and recover their accounts

The portal now handles **Forgot password?**, **Forgot username?**, and **new
signups that need email confirmation** on the login page. The code is done; the
flows only deliver once the Supabase project is configured to send the emails.
Steps 1–3 are dashboard-only settings — no SQL runs them, and nothing in this
codebase can apply them by itself either. See the checklist below for exactly
what's ready versus what still needs a person in the dashboard.

## Checklist

- [x] **Step 0 — Email-confirmation policy: decided and documented** (2026-08-25,
  see below). *Applying* it (below) is blocked on step 3.
- [ ] **Step 1 — Redirect URLs registered** *(dashboard action needed — values
  below are confirmed correct against the deployed code)*
- [ ] **Step 2 — `{{ .Token }}` added to all three email templates**
  *(dashboard action needed — exact snippet below)*
- [ ] **Step 3 — Real SMTP provider configured, rate limit raised**
  *(dashboard action needed, and needs your own Resend/SendGrid account —
  see below)*
- [ ] **Step 0b — Retire the auto-confirm trigger, once step 3 is live**
  *(this part I can do — SQL, not dashboard — but only after real email
  delivery works, see below)*

Tell me once you've clicked through 1, 2, or 3 in the dashboard and I'll tick
it off here with the date. I cannot click them myself — no tool this session
has reaches Supabase's Auth dashboard settings (only the database), and step 3
specifically needs an account and an API key from a mail provider that has to
be yours, not something I should ever hold or paste in on your behalf.

Everything below is in your project at
<https://supabase.com/dashboard/project/zptupvyrwoeabncxabgj>.

## 0. Decide whether new signups must confirm their email

**Decision (2026-08-25): yes, once step 3 is live. Until then, no — and that "no"
is not the dashboard toggle's doing.**

**Authentication → Sign In / Providers → Email → Confirm email** may say "on" in
the dashboard, but it has had no practical effect since `patch-11-open-signup.sql`
(2026-08-17): a database trigger, `on_auth_user_auto_confirm`, stamps every new
`auth.users` row as confirmed *before* Supabase's own signup logic checks the
column — the account gets a working session immediately, whatever the toggle
says. Checked directly against the live project today: every account that
exists, including one created three days after that patch shipped, is
confirmed. The toggle is currently decorative.

That trigger existed for a real reason — before it, confirmation email delivery
didn't work at all (no SMTP, step 3), so "must confirm" meant "can never sign
in." It should **stay in place until step 3 is actually done**. Turning it off
first reopens exactly the lockout it was built to fix.

**Once step 3 is live, drop the trigger** so the dashboard toggle starts
meaning something again and a real confirmation flow (link or code) gates first
login, matching the "on" behaviour described below. That's a small, reversible
SQL change — ask me to run it once you've confirmed test emails are actually
arriving; I'll do it as its own migration rather than folding it into step 3
itself, so it's easy to roll back if delivery turns out to be flaky.

**Why require it at all, rather than leave signup open:** accounts here are
self-serve — `4a7c0b0` made school optional at signup, and nothing today proves
a new teacher account's email address actually belongs to that teacher.
Confirmation closes that gap for the cost of one click in an email a real SMTP
setup will actually deliver. If that's not the tradeoff you want, override this
here and I'll update the recommendation.

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

**Status: not yet applied.** Values below re-derived from the live code today
(`recovery.js`, `app.js`, `util.js`'s `BASE`, and `.github/workflows/deploy.yml` —
no custom domain configured, so the GitHub Pages default applies) and confirmed
correct. Paste them into the dashboard field below and tell me — I can't reach
this screen myself.

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

**Status: not yet applied.** The snippet below is exact — paste it into each
template and tell me, so I can tick it off here.

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

**Status: not yet applied — and this one needs more than a dashboard click.**
Registering redirect URLs or pasting a template snippet is UI-only; this step
needs an account with a real mail provider, which has to be yours. I won't
create that account or ever hold its API key, even if I could reach this
screen — that's exactly the kind of credential I should never touch. Concretely:

1. **Pick a provider and make the account yourself:** Resend and SendGrid both
   work, per your note — either is fine for a few hundred staff. If you want a
   lean towards one: **Resend** tends to be the faster setup (API-key-based SMTP
   relay, generous free tier, no legacy dashboard to fight with), so it's the
   default unless HPF already has SendGrid for something else.
2. **Verify a sending domain** you control — `humanpractice.org` — via the
   SPF/DKIM DNS records the provider gives you. Skipping this is the single
   most common reason these emails land in spam.
3. **Generate SMTP credentials** (host, port, username, password) from the
   provider once the domain is verified.
4. **Paste them into Supabase:** *Project Settings → Authentication → SMTP
   Settings* → enable custom SMTP → fill in the four values above plus a sender
   address on the verified domain, e.g. `no-reply@humanpractice.org`.
5. **Raise the rate limit:** *Authentication → Rate Limits* still defaults to
   the development ceiling even after SMTP is on. Something like 30 emails/hour
   suits a few hundred staff; raise it further later if needed.

Tell me once mail is actually arriving (the test below is the way to check) —
I'll tick this off, and then run the SQL to retire the auto-confirm trigger
from step 0.

The built-in email service is for development only: it sends **at most a couple
of messages an hour**, and only to addresses belonging to your Supabase
organisation. A teacher who asks for a reset simply never gets an email, and
nothing in the portal or the dashboard says why.

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

**The test that actually proves step 3 worked** uses an address that isn't a
member of your Supabase organisation — the built-in dev mailer would happily
deliver to a colleague's address and make step 3 look done when it isn't. See
[`TESTING.md`](../TESTING.md) for the exact script.

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
