/* ============================================================
   HPF Digital Portal — offline-first store and sync engine.

   This EXTENDS the existing `hpf_fo_outbox` behaviour; it does not
   replace it blindly. What that outbox already got right is preserved
   exactly, because it was right:

     • a visit is never lost just because the network was down;
     • a CONNECTIVITY failure is retried forever, but a real refusal
       (RLS, no JWT) is NOT — retrying that is pointless and hides the
       problem from the officer. `syncFailureKind()` below is
       `foReportIsConnectivityFailure()`, kept verbatim in behaviour;
     • flushing happens on mount and on `window.online`.

   Anything already queued in localStorage is migrated into IndexedDB on
   first load (`migrateLegacyOutbox`) rather than abandoned — an officer
   mid-field-trip during a deploy must not lose the visits on their
   phone.

   What is new: IndexedDB instead of localStorage (bigger, structured,
   survives more), explicit per-record sync STATES, a client-generated
   idempotency key so a retry can never duplicate a visit server-side
   (patch-35), a school cache so forms work offline, and a sync history.
   ============================================================ */

const DB_NAME = "hpf_offline";
const DB_VERSION = 1;

/* Store names. `outbox` is the sync queue; `cache` is read-only reference
   data pulled while online; `synclog` is the history of sync attempts. */
export const STORE_OUTBOX = "outbox";
export const STORE_CACHE = "cache";
export const STORE_SYNCLOG = "synclog";

/* The six states a queued record moves through.

   LOCAL        saved on the device, not yet offered to the server (either
                we are offline, or it has not been picked up by a flush)
   PENDING_SYNC queued and eligible for the next flush
   SYNCING      a request for this record is in flight right now
   SYNCED       the SERVER confirmed it — we hold a server row id. Never
                set optimistically; that is the whole point.
   FAILED       the server refused it for a reason retrying cannot fix.
                Stays on the device, visible, never silently dropped.
   CONFLICT     the server already has a row with this client_id. The
                record is safe (it landed on an earlier attempt whose
                response we lost) but this device's copy needs
                reconciling rather than re-sending. */
export const SYNC = {
  LOCAL: "LOCAL",
  PENDING_SYNC: "PENDING_SYNC",
  SYNCING: "SYNCING",
  SYNCED: "SYNCED",
  FAILED: "FAILED",
  CONFLICT: "CONFLICT",
};

/* Record kinds the outbox can carry. Visits are live today; the other
   three share the same queue, states and flush loop so adding their write
   paths is wiring, not new infrastructure. */
export const KIND = {
  VISIT: "field_visit",
  ISSUE: "issue",
  ASSESSMENT: "assessment",
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in globalThis)) return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        const s = db.createObjectStore(STORE_OUTBOX, { keyPath: "id" });
        s.createIndex("state", "state", { unique: false });
        s.createIndex("kind", "kind", { unique: false });
        // The idempotency key. Unique here as well as in Postgres so the
        // same visit cannot even be queued twice on one device.
        s.createIndex("client_id", "client_id", { unique: true });
      }
      if (!db.objectStoreNames.contains(STORE_CACHE)) {
        db.createObjectStore(STORE_CACHE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORE_SYNCLOG)) {
        const s = db.createObjectStore(STORE_SYNCLOG, { keyPath: "id", autoIncrement: true });
        s.createIndex("at", "at", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let out;
        try {
          out = fn(s);
        } catch (err) {
          reject(err);
          return;
        }
        t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

const reqAsValue = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/* ------------------------------------------------------------ outbox */

export async function outboxAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_OUTBOX, "readonly");
    const req = t.objectStore(STORE_OUTBOX).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export const outboxByState = async (...states) =>
  (await outboxAll()).filter((r) => states.includes(r.state));

/* Everything not yet confirmed by the server. Used for the "pending
   synchronization" indicator — FAILED and CONFLICT are deliberately
   included: they are unfinished work the officer still needs to see. */
export const outboxUnsettled = async () =>
  (await outboxAll()).filter((r) => r.state !== SYNC.SYNCED);

export async function enqueue({ kind, table, row, label }) {
  const client_id = crypto.randomUUID();
  const rec = {
    id: client_id,
    client_id,
    kind,
    table,
    // The idempotency key travels WITH the row, so the server can reject a
    // duplicate on its own rather than trusting the device to be careful.
    row: { ...row, client_id },
    label: label || "",
    state: SYNC.LOCAL,
    attempts: 0,
    lastError: null,
    serverId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await tx(STORE_OUTBOX, "readwrite", (s) => s.add(rec));
  await logSync({ event: "queued", kind, client_id, detail: label || "" });
  return rec;
}

export async function setState(id, state, patch = {}) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_OUTBOX, "readwrite");
    const s = t.objectStore(STORE_OUTBOX);
    const get = s.get(id);
    get.onsuccess = () => {
      const rec = get.result;
      if (!rec) return; // deleted underneath us; nothing to update
      Object.assign(rec, patch, { state, updatedAt: Date.now() });
      s.put(rec);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export const removeFromOutbox = (id) => tx(STORE_OUTBOX, "readwrite", (s) => s.delete(id));

/* ------------------------------------------------------------ reference cache */

export async function cachePut(key, value) {
  await tx(STORE_CACHE, "readwrite", (s) => s.put({ key, value, at: Date.now() }));
}
export async function cacheGet(key) {
  const db = await openDb();
  const t = db.transaction(STORE_CACHE, "readonly");
  const rec = await reqAsValue(t.objectStore(STORE_CACHE).get(key));
  return rec ? rec.value : null;
}
export async function cacheMeta(key) {
  const db = await openDb();
  const t = db.transaction(STORE_CACHE, "readonly");
  const rec = await reqAsValue(t.objectStore(STORE_CACHE).get(key));
  return rec ? { at: rec.at, size: Array.isArray(rec.value) ? rec.value.length : 1 } : null;
}

/* ------------------------------------------------------------ sync history */

export async function logSync(entry) {
  try {
    await tx(STORE_SYNCLOG, "readwrite", (s) => s.add({ ...entry, at: Date.now() }));
  } catch {
    /* history is diagnostic; never let it break a sync */
  }
}

export async function syncHistory(limit = 50) {
  const db = await openDb();
  const t = db.transaction(STORE_SYNCLOG, "readonly");
  const all = await reqAsValue(t.objectStore(STORE_SYNCLOG).getAll());
  return (all || []).sort((a, b) => b.at - a.at).slice(0, limit);
}

const LAST_OK = "last_successful_sync";
export const setLastSuccessfulSync = (n = Date.now()) => cachePut(LAST_OK, n);
export const getLastSuccessfulSync = () => cacheGet(LAST_OK);

/* ------------------------------------------------------------ failure classification

   Behaviourally identical to app.js's foReportIsConnectivityFailure(),
   which this generalises rather than replaces: a genuine network failure
   never reaches PostgREST, so supabase-js has no structured error to hand
   back — only a message like "Failed to fetch". Anything WITH a Postgres
   code arrived and was declined, and retrying cannot change that.

   The one addition is 23505 on our own unique index: that is not a refusal
   at all, it means an earlier attempt already succeeded and we lost the
   response. */
export function classifyError(error) {
  if (!error) return "ok";
  const msg = (error.message || "").toLowerCase();
  if (error.code === "23505" || msg.includes("duplicate key")) return "duplicate";
  if (!error.code && /fetch|network|timeout|offline/i.test(msg)) return "offline";
  return "refused";
}

/* ------------------------------------------------------------ legacy migration

   The existing localStorage outbox, moved across verbatim. Items are
   copied into IndexedDB and only then removed from localStorage, so a
   crash mid-migration loses nothing (worst case an item is migrated
   twice, and the client_id unique index makes the second a no-op).

   A legacy item that was already marked `blocked` keeps that meaning: it
   becomes FAILED, not PENDING_SYNC, so a refusal the officer has already
   been told about does not silently start retrying again. */
const LEGACY_KEY = "hpf_fo_outbox";

export async function migrateLegacyOutbox() {
  let legacy = [];
  try {
    legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "[]");
  } catch {
    legacy = [];
  }
  if (!Array.isArray(legacy) || !legacy.length) return { migrated: 0 };

  let migrated = 0;
  for (const item of legacy) {
    const client_id = item.client_id || item.id || crypto.randomUUID();
    const rec = {
      id: client_id,
      client_id,
      kind: KIND.VISIT,
      table: "field_reports",
      row: { ...(item.row || {}), client_id },
      label: (item.row && item.row.school) || "",
      state: item.blocked ? SYNC.FAILED : SYNC.PENDING_SYNC,
      attempts: item.blocked ? 1 : 0,
      lastError: item.blocked || null,
      serverId: null,
      createdAt: item.at || Date.now(),
      updatedAt: Date.now(),
    };
    try {
      await tx(STORE_OUTBOX, "readwrite", (s) => s.add(rec));
      migrated++;
    } catch {
      /* already migrated (unique client_id) — fine, it is idempotent */
    }
  }
  localStorage.removeItem(LEGACY_KEY);
  await logSync({ event: "legacy_migrated", detail: `${migrated} item(s) from localStorage` });
  return { migrated };
}

/* ------------------------------------------------------------ the sync engine */

let syncing = false;
export const isSyncing = () => syncing;

/* Flush every unsettled record. `supabase` is injected rather than
   imported so this module stays testable and has no import cycle with
   app.js.

   Returns { attempted, synced, failed, conflicts, offline, changed }.
   `changed` drives a re-render — and is true for ANY state movement, not
   just success, because a record that turns out FAILED still needs its
   pill and reason to update. That behaviour is inherited from
   flushFoOutbox(), which got it right for the same reason. */
export async function flushOutbox(supabase, { onChange } = {}) {
  if (syncing) return { attempted: 0, synced: 0, failed: 0, conflicts: 0, offline: 0, changed: false, skipped: "already-syncing" };
  syncing = true;
  let synced = 0, failed = 0, conflicts = 0, offline = 0, changed = false;

  try {
    const queue = (await outboxAll()).filter(
      (r) => r.state === SYNC.LOCAL || r.state === SYNC.PENDING_SYNC || r.state === SYNC.SYNCING
    );
    if (!queue.length) return { attempted: 0, synced: 0, failed: 0, conflicts: 0, offline: 0, changed: false };

    await logSync({ event: "sync_started", detail: `${queue.length} record(s)` });
    onChange?.();

    for (const rec of queue) {
      await setState(rec.id, SYNC.SYNCING, { attempts: (rec.attempts || 0) + 1 });
      changed = true;
      onChange?.();

      const { data, error } = await supabase
        .from(rec.table)
        .insert(rec.row)
        .select("id")
        .maybeSingle();

      const kind = classifyError(error);

      if (kind === "ok") {
        // SERVER CONFIRMATION: only now, holding a real server row id.
        await setState(rec.id, SYNC.SYNCED, { serverId: data?.id || null, lastError: null });
        await logSync({ event: "synced", kind: rec.kind, client_id: rec.client_id, serverId: data?.id || null, detail: rec.label });
        synced++;
      } else if (kind === "duplicate") {
        // An earlier attempt DID land; we just never saw the response.
        // Recover the server row so the record ends up settled and
        // truthful rather than stuck retrying something already saved.
        const { data: found } = await supabase
          .from(rec.table).select("id").eq("client_id", rec.client_id).maybeSingle();
        if (found?.id) {
          await setState(rec.id, SYNC.SYNCED, { serverId: found.id, lastError: "Recovered: already on the server." });
          await logSync({ event: "duplicate_recovered", kind: rec.kind, client_id: rec.client_id, serverId: found.id, detail: rec.label });
          synced++;
        } else {
          // Unique violation but we cannot see the row — RLS is hiding
          // someone else's. Genuinely a conflict for a human to look at.
          await setState(rec.id, SYNC.CONFLICT, { lastError: "A record with this id exists but is not visible to this account." });
          await logSync({ event: "conflict", kind: rec.kind, client_id: rec.client_id, detail: rec.label });
          conflicts++;
        }
      } else if (kind === "offline") {
        // Preserved from the original outbox: stay queued, retry later,
        // do not count as a failure and do not bother the officer.
        await setState(rec.id, SYNC.PENDING_SYNC, { lastError: null });
        offline++;
      } else {
        // A real refusal. Kept on the device and surfaced — never dropped.
        await setState(rec.id, SYNC.FAILED, { lastError: error.message || "Refused by the server." });
        await logSync({ event: "failed", kind: rec.kind, client_id: rec.client_id, detail: error.message || "" });
        failed++;
      }
      onChange?.();
    }

    if (synced) await setLastSuccessfulSync();
    await logSync({ event: "sync_finished", detail: `synced ${synced}, failed ${failed}, conflicts ${conflicts}, still queued ${offline}` });
    return { attempted: queue.length, synced, failed, conflicts, offline, changed: true };
  } finally {
    syncing = false;
    onChange?.();
  }
}

/* Manual retry of a FAILED/CONFLICT record: moves it back into the queue
   so the next flush picks it up. Deliberately explicit — an automatic
   retry of a refusal is the behaviour the original outbox correctly
   avoided. */
export async function retryRecord(id) {
  await setState(id, SYNC.PENDING_SYNC, { lastError: null });
  await logSync({ event: "retry_requested", client_id: id });
}

export const isOnline = () => (typeof navigator === "undefined" ? true : navigator.onLine !== false);
