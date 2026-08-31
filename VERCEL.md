# Vercel — the second supported deployment

**Live:** https://hpf-digital-portal-2026.vercel.app

Formally supported as of this fix. Before this, Vercel was deploying this
repository (a Git integration configured outside any file here — nothing
in the repo referenced it), and every route except `/` was broken: a
blank white page on direct load, refresh, or a bookmarked link.

## What was broken, and why

This is a client-routed SPA with no server-rendered pages — `/curriculum`,
`/dashboard`, etc. are not real files, only paths `app.js`'s router
matches after the page loads. Making a direct request to one of those
paths therefore needs the *host* to fall back to serving the app shell.

GitHub Pages already had this covered: [`404.html`](404.html) is a copy of
`index.html` GitHub Pages serves (with an HTTP 404 status, but real body
content) for any path with no matching file — which is every clean route
on this SPA. Its asset tags are deliberately **hardcoded absolute paths
for GitHub Pages' own subdirectory** (`/HPF-digital-portal-2026/app.js`),
because that project site serves everything under that prefix.

Vercel serves this project at its domain root, not a subdirectory. When
Vercel's own default 404 handling picked up `404.html` for an unmatched
path, its hardcoded `/HPF-digital-portal-2026/...` asset paths pointed at
URLs that don't exist on this domain — `app.js`, `dashboards.js`, and
`styles.css` all 404'd in turn, and the SPA never booted. Confirmed
directly (network trace on `/dashboard`): a 404 status, followed by three
more 404s for the mis-pathed assets, rendering a blank page.

## The fix

[`vercel.json`](vercel.json) — a rewrite that sends every path with no
matching real file to `/index.html`, Vercel's own native mechanism for
this, rather than reusing GitHub Pages' 404-status trick:

```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
```

`index.html` already uses plain relative asset paths (`./app.js`,
`./styles.css`) — correct at any root, no edit needed. Vercel matches a
request against real files *before* it ever considers a rewrite, so
`/app.js`, `/styles.css`, `/config.js`, and every other real asset keep
being served directly and are untouched by this rule; it only fires for
the 7 paths that have no matching file.

**`404.html` was not touched.** GitHub Pages keeps using exactly the
mechanism it already had — this fix adds a second, independent path for
Vercel rather than changing the first one.

## Why this is safer than reusing `404.html` for Vercel too

A `vercel.json` rewrite returns a real **HTTP 200** and keeps the
requested URL in the address bar — strictly better than GitHub Pages' own
404-status-with-a-real-body approach (a real, if minor, nuance the 31 Aug
audit already flagged for GitHub Pages: a crawler or uptime monitor
checking status codes sees 404 for a page a human sees as normal). It also
means the two deployments' fallback mechanisms are fully independent:
changing one can't regress the other.

## Verifying a redeploy

After any push to `main`, both deployments update — GitHub Pages via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) (mirrors to
`gh-pages`), Vercel via its own Git integration (outside this repo's
config, same as before this fix — only *how it handles routing* changed,
not how it deploys). To confirm Vercel picked up a change: open
`https://hpf-digital-portal-2026.vercel.app/dashboard` directly — it
should load the login gate, not a blank page.
