# CI — verification before every deploy

Before this, `deploy.yml` mirrored `main` straight to `gh-pages` on every
push with no check in between — the exact gap the 31 Aug 2026 audit
flagged as a production risk, with precedent: a rich-text paste with
smart quotes broke every page on this site once already (`AUDIT.md`).

The pipeline is now:

```
git push
  │
  ▼
CI (.github/workflows/ci.yml)
  ├─ syntax & structural checks   (checks 1–4, 7)
  ├─ security checks              (checks 5–6)
  └─ smoke tests                  (check 8)
  │
  ▼  only if every check above passed
deploy (.github/workflows/deploy.yml's `deploy` job)
  └─ mirror main → gh-pages, exactly as it always has
```

No application code, database schema, or framework changed to build
this — every check below runs against this repo's real, existing shape
(a static, no-build, zero-dependency site) rather than assuming one that
doesn't exist here.

## The three workflow files

| File | Trigger | What it does |
|---|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | `workflow_call` only — never runs on its own | The actual checks. Called by the other two, so a PR and a push to `main` can never drift into checking different things. |
| [`pr.yml`](.github/workflows/pr.yml) | Any pull request targeting `main` | Runs `ci.yml`. Deploys nothing — a PR shouldn't, and a fork's PR has no `contents: write` permission to anyway. |
| [`deploy.yml`](.github/workflows/deploy.yml) | Push to `main`, or manual (`workflow_dispatch`) | Runs `ci.yml` as a job named `ci`; the `deploy` job now has `needs: ci` and will not start until it passes. The `deploy` job's own steps are untouched — same mirror-to-`gh-pages` push it has always done. |

## The 8 checks (`.github/scripts/verify.mjs` + `smoke-serve.sh`)

Both scripts are plain Node/bash, no dependencies — matching this repo's
own zero-build-step application code — and run identically locally and
in CI:

```bash
node .github/scripts/verify.mjs      # checks 1–7, and the pure-module half of 8
bash .github/scripts/smoke-serve.sh  # the other half of 8
```

1. **JavaScript syntax** — `node --check` on every tracked `.js` file.
2. **JSON validity** — `JSON.parse` on every tracked `.json` file.
3. **Local references resolve** — every `src=`/`href=` in `index.html`/`404.html`, and every relative `import ... from "./..."` in every `.js` file, is checked against a real file on disk. (Remote and bare specifiers — `https://esm.sh/...`, package names — are skipped; there's nothing local to verify.)
4. **Required files present** — a fixed list (`index.html`, `404.html`, `app.js`, `dashboards.js`, …, `vercel.json`) must all exist.
5. **No tracked secrets** — confirms `.env` isn't tracked, and scans every other tracked text file for secret-shaped strings (a Supabase `sb_secret_...` key, a PEM private key block, a generic `API_KEY="..."`-style assignment). `.claude/`/`.agents/` (vendored tooling docs, which deliberately show these exact patterns as placeholders to teach the naming convention) are excluded — scanning documentation-about-secrets for secret-shaped text is a guaranteed false positive, not a real finding.
6. **No accidental demo credentials** — scans application code and config (`.js`/`.sql`/`.json`, not prose docs) for a short list of known demo-credential strings (`admin1234`, `password123`, …). Deliberately scoped to code the app actually runs, not documentation describing something — see *Known limitation* below.
7. **Every route has a real handler** — parses `app.js`'s `ROUTES` object, confirms each of the 8 route handlers is actually defined or imported in `app.js`, and cross-checks `titleFor()` has a title for each one too.
8. **Smoke tests** — two halves, because this is a zero-dependency static site with no test runner:
   - **Pure modules**: `util.js`, `icons.js`, `data.js`, `config.js` have no DOM or network dependency at load time, so the script actually `import()`s each one and asserts its expected exports exist. This catches what `node --check` can't — `node --check` only parses, it never executes or resolves an import, so a broken export name would pass check 1 and fail here.
   - **Serve and fetch**: `app.js`/`dashboards.js`/`recovery.js` touch real DOM globals at module scope, and `supabase.js` imports from a remote `https://esm.sh/...` specifier — neither is safely `import()`-able in bare Node. `smoke-serve.sh` instead starts a plain static file server over the real repo (no SPA fallback of its own) and requests every real entry point a browser would, confirming each one serves with a real 200 and the homepage contains the expected `#app` mount point and module script tag.

## What happens when a check fails

`deploy`'s `needs: ci` means the deploy job is skipped entirely — not
attempted-and-failed, genuinely never started — when the `ci` job doesn't
succeed. Nothing reaches `gh-pages`. The failure shows directly in the
workflow run's summary, with the specific check and file that failed
(both scripts print exactly which one).

## Known limitations

- **Check 6 (demo credentials) is scoped to code, not documentation.**
  It would not catch a stale claim like "demo admin: `admin1234`" sitting
  in a `.md` file, only the same string appearing somewhere the app could
  actually execute it. This is deliberate — a prose inaccuracy is a
  documentation problem (tracked separately, see the 31 Aug audit), not a
  security check's job to block deploys over. If this repo's README is
  ever fixed to drop its own stale demo-credential claim, this check's
  scope won't need to change either way — it was never scanning `.md`
  files.
- **Check 5/6's pattern lists are not exhaustive secret detection.** They
  catch the specific shapes this project's own credentials take
  (Supabase keys, common demo-password strings) — they are not a
  substitute for a dedicated secret-scanning tool if this project's
  credential surface grows more varied later.
- **The smoke test doesn't execute client-side JS in a real browser.**
  `smoke-serve.sh` proves every file serves correctly at the right path
  with the right content; it doesn't click through the app or assert on
  rendered output. That level of testing was done manually, live, against
  both real deployments during the Vercel routing fix (see `VERCEL.md`)
  — this pipeline doesn't attempt to automate that yet.
- **No unit or integration tests exist for `dashboards.js`'s own logic**
  (the 11,000+ line file holding every dashboard, MDM, and the "360"
  profiles). This pipeline verifies the file is syntactically valid,
  correctly referenced, and serves — it does not verify any individual
  feature's behavior. That's a meaningfully larger undertaking than a
  first CI pass, and out of scope for this one.
- **PR checks don't block a merge by themselves** — enabling that needs a
  branch-protection rule on `main` (**Settings → Branches → Branch
  protection rules → Require status checks to pass**, selecting the `CI /
  Verify` check), which is a repository setting, not a workflow file —
  the same category of "dashboard-only, not something I can set myself"
  step as `AUTH-RECOVERY.md`'s SMTP configuration or `KOBO-INTEGRATION.md`'s
  secrets. The workflow runs and reports either way; only the *hard block
  on merge* needs that one setting turned on.

## Running the checks locally before you push

```bash
node .github/scripts/verify.mjs && bash .github/scripts/smoke-serve.sh
```

Both exit non-zero on any failure — safe to wire into a local pre-push
hook if you want the same gate before a push even leaves your machine,
not just after.
