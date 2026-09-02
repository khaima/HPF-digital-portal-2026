# Notifications — event catalogue, producer, and RLS audit

Activated by [patch-34](patch-34-notifications-activation.sql). **No new
table**: `notifications` has existed since [patch-13](patch-13-data-model-expansion.sql)
with real RLS (rewritten onto the permission matrix by patch-23) and never
had a producer — patch-13's own comment says so: *"Insert is admin-only for
now — no automated producer exists yet to write these on the app's behalf."*
This patch writes that producer.

Three columns were added to the **existing** table for facts the brief
requires that it could not store: `priority`, a structured related record
(`ref_table`/`ref_id`, the polymorphic shape `learning_activity` and
`evidence` already use), and `dedupe_key`, which is what actually enforces
"do not generate noisy notifications".

## Event catalogue

Every event is raised **server-side**, by a trigger on the table where the
event genuinely happens, or by a periodic sweep for the ones that are
states rather than events. No client can raise a notification for anyone
else — see the RLS audit below.

| # | Event | Type | Raised by | Recipients | Priority |
|---|---|---|---|---|---|
| 1 | New field assignment | `field_assignment` | trigger on `school_officer_assignments` | the assigned officer | normal |
| 2 | New action | `action_assigned` | trigger on `action_items` (insert, or re-assignment) | the assignee | normal |
| 3 | Overdue action | `action_overdue` | `hpf_notification_sweep()` | the assignee | high |
| 4 | High-priority issue | `high_priority_issue` | trigger on `interventions` | that school's leader + admin/PM | high |
| 5 | KPI at risk | `kpi_at_risk` | `hpf_notification_sweep()` | admin / PM / M&E | high |
| 6 | Failed Kobo synchronization | `kobo_sync_failed` | trigger on `kobo_sync_runs` | admin / PM | high |
| 7 | Failed offline synchronization | `offline_sync_failed` | `hpf_notify_offline_sync_failed()` from `flushFoOutbox()` | **the caller only** | high |
| 8 | Data-quality problem | `data_quality` | triggers on `kobo_submissions` and `learner_identity_reviews` | admin / PM (+ M&E for Kobo) | normal |
| 9 | Training assignment | `training_assigned` | trigger on `teacher_training` | the teacher | normal |
| 10 | Important administrative event | `admin_event` | trigger on `profiles` (role change) | the person whose role changed | high |

An intervention *is* the escalation path in this schema, so opening one is
the high-priority signal (event 4) — there is no separate priority column
on `interventions` to key off.

**KPI at risk** is defined as: the latest recorded `me_indicator_values`
value for an indicator, in the target's own period and scope, below **80%**
of its `me_targets.target_value`.

## Not generating noise

Four independent mechanisms, not just one:

1. **`dedupe_key`, with a unique index.** One notification per (recipient,
   event). A daily overdue sweep re-running cannot stack duplicates —
   verified: sweep run 1 produced 1, run 2 produced 0.
2. **Transition-only triggers.** `kobo_sync_failed` fires on the transition
   *into* `failed`, not on every touch of the row — verified: two further
   updates to an already-failed run produced no new rows.
3. **Never notify the actor about their own action.** Assigning yourself a
   school, an action or a training record produces nothing.
4. **Narrow recipients.** Role fan-out (`hpf_notify_roles`) is used only
   for events that genuinely have no single owner. Everything with an owner
   goes to that one person.

Two more, specific to the noisiest case: the offline-sync notification is
raised only for a report the server **actively refused** (not for ordinary
offline queuing, which is normal in the field), and its dedupe key is
per-person-per-day, so a device retrying every few minutes still produces
at most one.

## Retrieval UI

An **Alerts** bell in the dashboard header with an unread count, opening a
panel below it. Both live outside `#dashBody` so they survive role-tab
re-renders.

| Requirement | Where |
|---|---|
| read / unread | Unread / All filter; unread rows carry a left accent bar and a "new" tag |
| mark as read | Per-row tick, plus "Mark all read" |
| priority | Pill on every row (`low`/`normal`/`high`/`urgent`) |
| timestamp | Relative age via `timeAgo()` |
| related record | `ref_table` shown on the row; `link` becomes an **Open** button |
| notification type | Icon + human label from `NOTIF_TYPE` |

The client **never filters by recipient**. It doesn't need to and
shouldn't: the `notifications view` policy already scopes every row. A
client-side `.eq("recipient_id", …)` would imply the client is what
enforces ownership, which it isn't.

## RLS audit

Access paths, and what each is gated by:

| Path | Gate | Effect |
|---|---|---|
| `SELECT` | `has_perm('people','view') AND (recipient_id = auth.uid() OR is_programme_manager())` | You see your own. Programme managers see all — deliberate oversight, consistent with their access to profiles, interventions and returns |
| `UPDATE` | `recipient_id = auth.uid() OR (has_perm('people','edit') AND is_programme_manager())`, **plus a column grant limited to `read_at`** | You can mark your own read, and nothing else — not even the title of your own notification |
| `INSERT` | `has_perm('people','create') AND is_programme_manager()` | No ordinary user can create a notification at all |
| `DELETE` | `has_perm('people','delete') AND is_programme_manager()` | Unchanged |
| `hpf_notify` / `hpf_notify_roles` | **Not executable by `anon` or `authenticated`** | The producer is unreachable from any client |
| `hpf_notify_offline_sync_failed` | `authenticated` only; notifies `auth.uid()` and nobody else | Self-notification cannot be a spam vector |
| `hpf_notification_sweep` | `authenticated`, with an internal `is_admin() OR is_programme_manager()` check | An ordinary user cannot use it to push notifications to others |
| `hpf_mark_notifications_read` | `SECURITY INVOKER` — subject to the UPDATE policy above | Structurally cannot touch another user's rows |

### Two defects found by the audit, both fixed

**1 — `hpf_notify()` was callable by `anon` (security hole).** Supabase's
default privileges `GRANT EXECUTE` on every new function to `anon` and
`authenticated`, so the `revoke ... from public` in the first draft was a
no-op against those *explicit* role grants. Anyone holding the publishable
key could have forged a notification to any user. Caught by test R6; fixed
by revoking the roles by name. The trigger functions were revoked too, for
consistency with patch-04/patch-28, though a function returning `trigger`
is not invocable via PostgREST anyway.

**2 — recipients could not mark their own notifications read.** The
existing UPDATE policy required `has_perm('people','edit')`, held only by
`admin` and `programme_manager` — so a teacher, field officer or school
leader could read their notifications but never clear them, making the
feature unusable for the roles it serves most. Caught by test R8. Marking
your own notification read is not a people-management action, so that gate
was removed from the self case; ownership is unchanged and still the
boundary, and PM oversight is retained exactly as before. A column-level
grant (`UPDATE (read_at)`) was added so the widened row access cannot be
used to rewrite notification content.

## Tests (2026-09-01, live database, all rolled back)

**Event → notification → correct user** (7/7)

| Test | Result |
|---|---|
| E1 field assignment → exactly the assigned officer, correct `ref_table` | ✅ 1 row |
| E2 issue opened → that school's leader + admins, **not** other officers | ✅ 5 recipients, none of them the peer officers |
| E3 action assigned → the assignee only | ✅ 1 row |
| E4 Kobo sync failed → only `admin`/`programme_manager`, priority high | ✅ 4 recipients, zero outside those roles |
| E6 role change → that person only, priority high | ✅ 1 row |
| E7 overdue sweep → the assignee, **idempotent** on re-run | ✅ run 1 = 1, run 2 = 0, total 1 row |
| N1 repeated failure does **not** duplicate | ✅ rows = distinct recipients |

**RLS / unauthorized access** (11/11)

| Test | Result |
|---|---|
| R1 owner reads their own | ✅ visible |
| R2 **peer field officer cannot read it** | ✅ 0 rows |
| R3 peer cannot mark it read via the RPC | ✅ 0 affected |
| R4 peer cannot `UPDATE` it directly | ✅ blocked by RLS |
| R5 peer cannot forge one via `INSERT` | ✅ RLS violation |
| R6 `hpf_notify` not callable by a client | ✅ permission denied |
| R6b `hpf_notify_roles` not callable by a client | ✅ permission denied |
| R7 non-admin cannot run the sweep | ✅ refused |
| R8 owner (a `field_officer`) **can** mark their own read | ✅ 1 affected |
| R9 `read_at` actually persisted | ✅ |
| R10 owner cannot edit the title of their own notification | ✅ permission denied (column grant) |

**UI** — bell shows the correct unread count (2 of 3, excluding the read
one); Unread/All filters correct; per-row mark-as-read drops the count to
1; "Mark all read" clears it and shows "You're up to date"; the RPC is
called with `[id]` for one and `null` for all; panel closes cleanly. No JS
errors.

All test data ran inside `BEGIN … ROLLBACK`; `notifications`,
`interventions`, `action_items`, `kobo_sync_runs` and `schools` were
verified back at their prior row counts (0) afterwards. Every new function
carries a pinned `search_path`.

## Not done

- **The sweep is not scheduled.** `hpf_notification_sweep()` exists,
  is idempotent and is permission-gated, but nothing calls it on a
  timer yet. It wants a `pg_cron` entry (daily) or an Edge Function
  invocation — the same choice [KOBO-INTEGRATION.md](KOBO-INTEGRATION.md)
  documents for `kobo-sync`, and it needs the same scheduling decision.
  Until then, events 3 and 5 (overdue actions, KPI at risk) only fire when
  the function is called by hand.
- No email/push delivery — in-app only.
- No per-user notification preferences (mute a type, digest instead of
  immediate). The anti-noise controls above are system-wide rather than
  per-person.
