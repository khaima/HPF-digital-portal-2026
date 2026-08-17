# Deploying the Community Resources assistant

The **Community Resources** page (`/community-resources`) is a public chat —
no sign-in required — that answers questions about Maasai community &
culture, education, healthcare, and translation into the Maa language. The
chat UI in `app.js` is already wired to call a Supabase Edge Function named
`community-resources-chat`; the function itself lives at
[`functions/community-resources-chat/index.ts`](functions/community-resources-chat/index.ts)
but isn't live until you deploy it, which this environment can't do for you
(no Supabase CLI is installed here, and deploying needs your own account).

Until you deploy it, the page still works — the chat just replies "I
couldn't reach the assistant just now" for every message.

## What you do

1. **Get an Anthropic API key** — [console.anthropic.com](https://console.anthropic.com) →
   **API Keys** → create one. This is separate from your Supabase project.

2. **Install the Supabase CLI** (one-time), if you don't have it:

   ```bash
   npm install -g supabase
   ```

3. **Log in and link this project**:

   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   ```

   The project ref is the subdomain in your Supabase URL — for
   `https://zptupvyrwoeabncxabgj.supabase.co` (see [`config.js`](../config.js)) it's `zptupvyrwoeabncxabgj`.

4. **Store the key as a secret** (this is what keeps it out of the browser
   bundle — never put it in `config.js`):

   ```bash
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   ```

5. **Deploy the function, public (no login required)**:

   ```bash
   supabase functions deploy community-resources-chat --no-verify-jwt
   ```

   `--no-verify-jwt` matters here: everything else in this app requires a
   Supabase session, but Community Resources is meant for anyone, signed in
   or not.

6. **Try it** — open `/community-resources` on the live site and send a
   message. If it still says it can't reach the assistant, check
   **Supabase Dashboard → Edge Functions → community-resources-chat → Logs**
   for the error (most often a missing/incorrect `ANTHROPIC_API_KEY`, or the
   deploy step above being skipped).

## Changing the assistant's behaviour

The system prompt — what it will and won't answer, its tone, the "urgent
matters" disclaimer — lives in `SYSTEM_PROMPT` inside
[`functions/community-resources-chat/index.ts`](functions/community-resources-chat/index.ts).
Edit it and re-run step 5 to redeploy.

The four areas shown as buttons on the page (`SUPPORT_AREAS` in `app.js`) are
just prompt shortcuts for the visitor — changing them doesn't require
touching the function.
