# Offline-first PWA — field officer

Extends the existing `hpf_fo_outbox` capability into a real offline-first
progressive web app. Server support is
[patch-35](patch-35-offline-sync.sql); the client is `offline.js`, `sw.js`
and `manifest.webmanifest`.

## What already existed, and what was kept

The pre-existing outbox was not replaced blindly. It was read first, and
three things it got right are preserved exactly, because they were right:

| Existing behaviour | Kept |
|---|---|
| A visit is never lost because the network was down | Yes — strengthened (see below) |
| A **connectivity** failure retries forever; a **real refusal** (RLS, no JWT) does not | Yes — `classifyError()` is `foReportIsConnectivityFailure()` generalised, same rule |
| Flush on page mount and on `window.online` | Yes, both still fire |
| Re-render on *any* state change, not only success | Yes — a record that turns out failed still has to update its pill |
| A refusal raises the patch-34 self-notification once per person per day | Yes, unchanged |

Anything queued under the old localStorage key is **migrated**, not
abandoned: `migrateLegacyOutbox()` copies each item into IndexedDB and only
then clears the key, so a crash mid-migration loses nothing. An item the
old code had marked `blocked` becomes `FAILED`, not `PENDING_SYNC` — a
refusal the officer was already told about must not silently start
retrying.

**The one deliberate behaviour change:** the visit is now written to
IndexedDB *before* any network call, not only after one fails. The old
order left a window where a visit existed solely inside an in-flight
fetch — close the tab there, or lose power in the field, and it was gone
with no trace.

## Components

| Piece | File | Notes |
|---|---|---|
| Manifest | `manifest.webmanifest` | standalone, scoped `./` so it works under GitHub Pages' subpath and Vercel's root alike; icons generated as PNG, not binary-committed |
| Service worker | `sw.js` | App **shell only** |
| IndexedDB + sync engine | `offline.js` | `outbox`, `cache`, `synclog` stores |
| Status UI | `app.js` → `syncStatusPanel()` | the five required indicators |

### Why the service worker does not cache API responses

Deliberate, and worth stating because it looks like an omission:

1. A stale API response would silently contradict the sync states — an
   officer could see a "synced" visit the server has never heard of.
2. Every Supabase request carries an `Authorization` header. Caching
   authenticated responses in a shared Cache Storage bucket is how one
   user's data ends up in another's browser on a **shared field device**,
   which is exactly the deployment this targets.

Data goes through IndexedDB, where it carries an explicit state, or it is
not served offline at all.

## Sync states

| State | Meaning |
|---|---|
| `LOCAL` | Saved on the device, not yet offered to the server |
| `PENDING_SYNC` | Queued and eligible for the next flush |
| `SYNCING` | A request for this record is in flight |
| `SYNCED` | **The server confirmed it** — a server row id is held. Never set optimistically |
| `FAILED` | Refused for a reason retrying cannot fix. Stays on the device, visible |
| `CONFLICT` | The server already has this `client_id` but the row is not visible to this account |

## The six requirements

| Requirement | How |
|---|---|
| No silent data loss | Persist to IndexedDB before any network call; `FAILED`/`CONFLICT` records stay on the device and are surfaced with a Retry control; nothing is ever deleted on failure |
| Duplicate prevention | A `client_id` UUID generated on the device travels with the row; `field_reports.client_id` is **UNIQUE** (patch-35). A retry after a lost response collides instead of duplicating — a server guarantee, not a client hope |
| Retry | Automatic on mount and on reconnect for connectivity failures; **explicit, officer-initiated** for refusals (auto-retrying a refusal is what the original correctly avoided) |
| Conflict handling | On `23505`, the client re-reads the row by `client_id`. Found → `SYNCED` with the recovered server id. Not visible → `CONFLICT` for a human |
| Server confirmation | `SYNCED` is set only from a server response carrying a row id |
| Sync history | Every queue/start/synced/failed/conflict/finish event in the `synclog` store, shown in the panel |

## What the officer sees

Online · Offline · pending count · last successful synchronisation · failed
count — plus how many assigned schools are cached and how old that cache
is. All from real state.

## Offline data cached

`school_officer_assignments` → the assigned-school list, refreshed on every
successful online load and read back when the fetch fails. Without it the
visit form has nothing to pick and an officer in the field can file
nothing. Postgres stays authoritative; the UI says when the cache is being
used and how old it is.

## Records covered

Visits (`field_reports`) are live. Issues and assessments share the same
queue, states, flush loop and idempotency via `KIND` — adding their write
paths is wiring, not new infrastructure. They are **not** wired yet and
are not claimed to be.

## The 14-step scenario — all steps pass

Run 2026-09-02 in a real browser against the real app.

| Step | Result |
|---|---|
| 1–2 Login online, download assigned school data | ✅ 2 schools cached to IndexedDB; form populated |
| 3–4 Disconnect, close browser | ✅ |
| 5 Reopen portal | ✅ App boots offline; school list served from IndexedDB |
| 6–7 Create + save field visit | ✅ "Offline — working on this device"; **1 pending**; **nothing sent to the server** |
| 8–9 Close application, reopen | ✅ Record survived teardown: state `LOCAL`, payload and `client_id` intact, visible in the list, still nothing sent |
| 10 Reconnect internet | ✅ `online` event fired |
| 11 Synchronize | ✅ Auto-synced on reconnect → `SYNCED`, server id recorded, exactly **one** payload sent, panel shows "Last successful synchronisation just now" |
| 12 Verify PostgreSQL | ✅ Row present, inserted through the **real RLS policy** as the real field officer, all fields correct |
| 12b Duplicate retry | ✅ Blocked by `client_id` unique index; still exactly one row |
| 13 Verify dashboard | ✅ Visible to the dashboard's own RLS-scoped query |
| 14 Verify audit trail | ✅ One `audit_logs` `create` row for `field_reports` with the officer as actor |

Steps 1–11 ran end-to-end in the browser. Steps 12–14 executed the exact
payload the browser produced (same `client_id`) against real PostgreSQL
with `request.jwt.claims` set to the real field officer, so the genuine RLS
policy and the genuine audit trigger both ran; only the PostgREST HTTP hop
was not re-exercised, which is not what this feature changes. All server
test data ran inside `BEGIN … ROLLBACK`.

### Additional behaviours verified

- **Duplicate recovery**: server returns `23505`, client re-reads by
  `client_id`, recovers the server id → `SYNCED`, not stuck retrying.
- **Real refusal** → `FAILED`, payload preserved, manual retry returns it
  to `PENDING_SYNC` with data intact.
- **Network failure** → stays `PENDING_SYNC`, counted as offline, **not**
  `FAILED` — the preserved original behaviour.
- **Legacy migration**: both localStorage items migrated with `client_id`s,
  the previously-`blocked` one correctly became `FAILED`, the key was
  cleared, and re-running migrated nothing further.
- **True offline shell**: with the dev server **stopped entirely**, a full
  reload still booted the app from the service worker cache, on the correct
  route, with the sync panel and the outstanding `FAILED` record intact.

### A real bug this testing found and fixed

Reopening offline briefly showed "No schools assigned yet" while the cached
list was still loading — `foSchoolsLoaded` was flipped before the cache
fallback resolved, so a competing in-flight render could paint a wrong
answer. The flag is now set only once the answer is known, so an
intervening render shows "Loading…" instead of something false.

### A second real bug, found later: shipped fixes looked like they hadn't shipped

`sw.js`'s shell caching started cache-first-then-background-refresh: a
returning visitor got whatever was cached, and the fetch that would have
updated it only landed *after* that response was already sent — so a
deploy only became visible on the visitor's second reload, not the first.
During active development that's indistinguishable from the fix not having
shipped at all. Now network-first (`VERSION` bumped to `hpf-shell-v2` to
also clear out anyone's stale v1 cache): an online load always gets the
current deploy and refreshes the cache with it; the cache is purely the
offline fallback, used only when the network fetch itself fails. The
already-verified "true offline shell" behaviour (steps 1–14 above) is
unchanged — a failed fetch still falls back to whatever's cached, exactly
as before, just via a `catch` instead of a `hit ||`.

## Not done

- **Issues and assessments are not wired** to the outbox yet (see above).
- **No Background Sync API** — flushing happens on mount, on reconnect and
  on demand. Background Sync would add retry while the tab is closed; it is
  Chromium-only and was not needed for the scenario.
- **The `migrated` counter under-reports** when a concurrent boot migration
  has already inserted the same items. Cosmetic: the records, their states
  and idempotency are all correct; only the diagnostic count differs.
- **No offline conflict merge UI** — `CONFLICT` records are surfaced with
  their reason and a retry control, but resolving a genuine divergence is
  still a human decision made against the server record.
