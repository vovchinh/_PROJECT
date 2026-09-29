# CODEX MASTER DEBUG PROMPT — TikTok LIVE Connection, Comments, Viewers & ChiDiPos Completion

## Mission

Diagnose and complete the real TikTok LIVE connection pipeline in the existing ChiDi ERP + ChiDiPos V2 project.

Current observed symptom from the UI:

```text
TikTok channel selected
@hoamocyb

Status:
Đang kết nối...

Duration: —
Comments: —
Committed products: —
Customer STT: —
```

The connection never reaches a stable LIVE state, comments are not displayed, viewer counts are missing, and dependent LIVE features are not activated.

Do NOT assume this is a frontend-only bug.

Trace the complete pipeline end-to-end.

---

## 0. Read Context First

Read:

```text
AGENTS.md
docs/ai/CONTEXT_INDEX.md
docs/ai/CONTEXT_BUNDLES.md
docs/ai/REPO_MAP.md
docs/architecture/SYSTEM.md
docs/architecture/DATABASE.md
docs/architecture/INVARIANTS.md
docs/architecture/INTEGRATIONS.md
docs/engineering/COMMANDS.md
docs/engineering/TESTING.md
docs/verification/CURRENT.md
active Phase C plan
```

If some files do not exist, use the equivalent current files.

Current repository, migrations, tests, and runtime behavior are the source of truth.

Use the smallest relevant context bundle, preferably:

```text
@context:live
@context:database
@context:verification
```

---

## 1. Safety Rules

Do NOT:

- rewrite the project;
- edit migrations 001/002/003;
- reset Supabase data;
- put TikTok secrets/tokens in frontend;
- make React responsible for the LIVE WebSocket;
- fake comments/viewer counts;
- fabricate success when TikTok is not actually connected;
- hide listener errors behind an infinite loading state;
- couple TikTok-specific raw payloads directly to the core business domain;
- implement Zalo/shipping/COD while solving this issue;
- deploy or mutate production without explicit authorization.

Keep React JS/JSX conventions.

Authoritative server actor must come from `auth.uid()` when business mutations are involved.

---

## 2. Architecture to Verify

Preferred pipeline:

```text
TikTok LIVE
    ↓
TikTok LIVE Provider / Listener
    ↓
Normalized Event Adapter
    ↓
Live Ingest API / Supabase
    ↓
PostgreSQL
    ↓
Supabase Realtime / read API
    ↓
React ChiDiPos UI
```

The long-running listener should normally run in a long-lived Node.js process/service or another runtime designed for persistent WebSocket connections.

Do NOT assume a short-lived serverless/Edge Function is a reliable permanent TikTok LIVE WebSocket worker.

If current code tries to keep TikTok LIVE connectivity in an Edge Function:
- document it;
- prove whether it works;
- move only the listener responsibility to an appropriate long-running runtime if required.

Business source of truth remains PostgreSQL.

---

## 3. T0 — Build a Connectivity Audit

Before fixing code, create:

```text
docs/verification/TIKTOK_LIVE_CONNECTIVITY_AUDIT.md
```

Map:

```text
TikTok channel settings UI
Connect button handler
Frontend connection state machine
Repository/service call
Listener service
Provider library
Provider version
Room lookup
WebSocket connection
Comment event handler
Viewer-count event handler
Session persistence
Supabase ingest
Realtime subscription
UI selectors/hooks
Disconnect/reconnect
Logging
Error propagation
Timeout behavior
```

Classify each:

```text
IMPLEMENTED
PARTIAL
MISSING
BROKEN
UNVERIFIED
```

Do not change product code until this map is clear.

---

## 4. Find the Actual TikTok Provider

Search:

```text
tiktok
TikTokLiveConnection
WebcastPushConnection
TikTokLiveConnector
WebcastEvent
chat
roomUser
viewerCount
roomId
fetchRoomId
fetchIsLive
connect()
disconnect()
websocket
listener
```

Inspect package.json and lockfile.

Record:
- library name;
- installed version;
- runtime;
- exact connection API;
- event names currently used.

Do NOT code against documentation for a different version.

---

## 5. Verify TikTok Username Normalization

UI shows IDs such as:

```text
@hoamocyb
```

but provider may require:

```text
hoamocyb
```

Create one canonical helper:

```text
normalizeTikTokUsername(input)
```

Requirements:
- trim;
- remove leading `@`;
- validate allowed format;
- reject blank input;
- normalize consistently;
- keep display formatting separate from stored canonical value.

Tests:

```text
@hoamocyb
hoamocyb
  @hoamocyb
```

must resolve to the same canonical username.

---

## 6. Fix the Connection State Machine

Current UI appears stuck in CONNECTING.

Target:

```text
IDLE
↓
CHECKING_LIVE
↓
CONNECTING
↓
LIVE
```

Branches:

```text
NOT_LIVE
TIMEOUT
ERROR
RECONNECTING
DISCONNECTED
```

Every connection attempt MUST terminate into:

```text
LIVE
NOT_LIVE
TIMEOUT
ERROR
```

Never spin forever.

Create stable error codes such as:

```text
TIKTOK_USER_INVALID
TIKTOK_NOT_LIVE
TIKTOK_ROOM_LOOKUP_FAILED
TIKTOK_CONNECT_TIMEOUT
TIKTOK_WEBSOCKET_FAILED
TIKTOK_PROVIDER_RATE_LIMITED
TIKTOK_PROVIDER_UNAVAILABLE
TIKTOK_LISTENER_OFFLINE
TIKTOK_SESSION_CONFLICT
```

UI shows friendly text; diagnostics keep technical details.

---

## 7. Add Developer Connection Diagnostics

Developer/admin-only panel:

```text
Selected TikTok ID
Normalized username
Provider
Provider version
Listener service status
Room lookup state
Resolved room ID
WebSocket state
Last provider event
Last normalized event
Last DB ingest
Last Realtime update
Reconnect attempts
Last error code
Last error message
```

Never expose:
- tokens;
- cookies;
- service role keys;
- secrets.

---

## 8. Listener Health

If listener service exists, expose health/readiness equivalent to:

```text
GET /health
GET /ready
```

Report:

```text
process up
provider initialized
Supabase connectivity
active listener count
uptime
version/commit
```

Frontend must not remain indefinitely CONNECTING when listener service is unavailable.

---

## 9. Idempotent Connect/Disconnect

Implement a safe logical command equivalent to:

```text
start_live_monitor(channel_id)
stop_live_monitor(session_id)
```

Repeated CONNECT for the same active channel must not create duplicate listeners or sessions.

Logical identity should include:

```text
workspace_id
normalized channel
active room/session
```

Repeated DISCONNECT must be safe.

---

## 10. Diagnose Room Lookup Separately

Instrument these independently:

```text
username normalization
is-live lookup
room-id lookup
WebSocket connect
first provider event
```

Do not collapse all failures into one generic message.

If current provider exposes functions such as:

```text
fetchIsLive()
fetchRoomId()
connect(roomId)
```

test those independently where appropriate.

Record timing and failure reason.

---

## 11. Provider Adapter

Core app depends on:

```text
LiveCommentProvider
```

not the package directly.

Suggested contract:

```js
class LiveCommentProvider {
  async checkLive(channel) {}
  async connect(channel, handlers) {}
  async disconnect(connectionId) {}
  async healthCheck() {}
}
```

Implementations:

```text
TikTokWebcastProvider
SimulatorLiveProvider
ManualLiveProvider
```

---

## 12. Normalized Event Contract

Normalize provider events.

Connection:

```js
{
  type: "LIVE_CONNECTED",
  workspaceId,
  channelId,
  sessionId,
  externalRoomId,
  occurredAt
}
```

Comment:

```js
{
  type: "COMMENT",
  provider,
  externalEventId,
  externalRoomId,
  externalUserId,
  username,
  displayName,
  avatarUrl,
  text,
  occurredAt,
  rawPayload
}
```

Viewer count:

```js
{
  type: "VIEWER_COUNT",
  externalRoomId,
  viewerCount,
  occurredAt
}
```

Also support only if provider emits them:

```text
LIKE
MEMBER_JOIN
FOLLOW
SHARE
GIFT
```

Do not make raw provider payload the app domain model.

---

## 13. Trace Comments End-to-End

Prove each hop:

```text
provider chat event
↓
normalized COMMENT
↓
ingest
↓
database
↓
Realtime
↓
React
```

Verify:
- listener subscribed to the correct event;
- event name matches installed provider version;
- payload mapping is correct;
- dedup key works;
- workspace/session IDs exist;
- DB insert succeeds;
- RLS/server permissions are correct;
- Realtime listens to correct channel/table;
- UI receives/refetches state.

Do not patch only the comment list.

---

## 14. Viewer Count

Viewer count is a separate event/metric.

Inspect whether provider emits something equivalent to:
- ROOM_USER;
- room stats;
- viewer count.

Normalize to:

```text
VIEWER_COUNT
```

Persist at minimum:

```text
current_viewer_count
peak_viewer_count
last_viewer_count_at
```

Avoid storing every high-frequency stats packet forever unless analytics require it.

UI:

```text
Người xem hiện tại
Cao nhất
```

Unknown value remains `—`, not fake `0`.

---

## 15. Duration

Duration must not depend on comments.

Use:

```text
session.connected_at
```

or reliable provider live-start timestamp.

Start timer only after connection success.

Stop/freeze on disconnect/end.

---

## 16. Session Persistence

On successful connection create/reuse the active session idempotently.

Persist according to current schema conventions:

```text
workspace_id
channel_id
campaign_id
provider
external_room_id
status
connected_at
last_event_at
disconnected_at
error_code
```

Reconnect must not create duplicate active sessions.

New DB changes use new migrations only.

---

## 17. Campaign Reuse

If current Phase C architecture groups by business date, reuse campaign by:

```text
workspace
channel
Asia/Ho_Chi_Minh business date
```

Do not expose internal campaign UUIDs to seller UI.

---

## 18. Trusted Ingest Path

Listener should write via trusted server path:

```text
listener
→ secure ingest/RPC
→ database
```

Never place service-role secrets in React.

Validate:
- workspace/session;
- event IDs;
- timestamps;
- deduplication;
- bounded raw payload.

---

## 19. Supabase Realtime

Audit:
- Realtime enabled on required tables;
- subscription filters;
- workspace/session filter;
- cleanup/unsubscribe;
- reconnect behavior;
- duplicate subscriptions.

UI pattern:

```text
initial authoritative fetch
+
Realtime deltas
```

After reconnect:
refetch authoritative state.

---

## 20. LIVE Dashboard

On success show:

```text
● ĐANG LIVE
@hoamocyb

Thời lượng       00:18:43
Người xem        128
Bình luận        452
Khách có STT     37
SP đã chốt       64
Máy in           Sẵn sàng
```

Only show metrics the provider/system actually supports.

---

## 21. Connection UX

IDLE:

```text
Bật LIVE trên TikTok và bấm kết nối
@hoamocyb
[KẾT NỐI LIVE]
```

CHECKING:

```text
Đang kiểm tra LIVE...
```

CONNECTING:

```text
Đã tìm thấy LIVE.
Đang kết nối bình luận...
```

LIVE:

```text
● ĐANG LIVE
```

NOT_LIVE:

```text
Không tìm thấy phiên LIVE đang hoạt động cho @hoamocyb.
Hãy bắt đầu LIVE trên TikTok và thử lại.
[THỬ LẠI]
```

ERROR:

```text
Không thể kết nối TikTok LIVE.
[MỞ CHẨN ĐOÁN]
[THỬ LẠI]
```

No infinite spinner.

---

## 22. Reconnect

Implement bounded exponential/backoff reconnect consistent with current project conventions.

Reconnect must not:
- duplicate sessions;
- duplicate comments;
- duplicate Realtime subscriptions;
- duplicate provider listeners.

After max attempts:
go to ERROR and allow retry.

---

## 23. Classify Provider Failures

At least classify:

```text
not live
user/room not found
room lookup failure
rate limited
signing/token failure
network timeout
WebSocket closed
provider/protocol changed
listener unavailable
Supabase ingest failure
Realtime failure
```

Do not expose raw stack trace to seller.

---

## 24. Mandatory Simulator Isolation Test

Before blaming TikTok, prove all downstream layers.

Simulator emits:

```text
COMMENT
VIEWER_COUNT
MEMBER_JOIN
```

Expected:

```text
normalized event
→ DB
→ Realtime
→ UI
```

Interpretation:

```text
Simulator works, real TikTok fails
→ provider/listener problem.

Simulator fails
→ ingest/DB/Realtime/UI problem.
```

This test is mandatory.

---

## 25. Direct Provider Smoke Script

Create a developer-only script, e.g.:

```text
scripts/live/test-tiktok-connection.mjs
```

Input:

```text
username
```

Output:

```text
normalized username
is-live result
room-id result
connect result
first comment observed?
first viewer event observed?
disconnect result
timings
error code
```

Add timeouts.

Do not print secrets.

This bypasses React and Supabase.

Purpose:
prove provider connectivity independently.

---

## 26. End-to-End Diagnostic

Then verify:

```text
Provider
→ listener
→ normalized event
→ ingest
→ DB
→ Realtime
→ UI
```

Use test environment/workspace.

Do not mutate production without approval.

---

## 27. Logging

Structured logs:

```text
timestamp
level
component
workspace_id
channel_id
session_id
provider
external_room_id
event_type
attempt
correlation_id
error_code
duration_ms
```

Never log secrets or sensitive tokens.

---

## 28. Freshness Watchdog

While LIVE distinguish:

```text
no comments
```

from:

```text
dead connection
```

Use provider/WebSocket health where available.

Track:

```text
last_provider_event_at
last_comment_at
last_viewer_update_at
```

Show degraded state if data becomes stale.

---

## 29. Tests

Unit:
- username normalization;
- connection state reducer;
- provider event mapping;
- error mapping;
- retry policy;
- viewer mapping;
- comment mapping.

DB:
- workspace isolation;
- session uniqueness;
- comment dedup;
- RLS;
- session state.

Integration:
- Simulator → DB;
- Simulator → Realtime;
- Listener → ingest.

E2E:
- save TikTok ID;
- select ID;
- connect;
- live detected;
- comments appear;
- viewer count appears if supported;
- duration runs;
- disconnect;
- history persists.

---

## 30. Critical Failure Tests

Test:

```text
offline account
invalid username
double CONNECT
connect timeout
room lookup failure
WebSocket close
listener restart
Supabase temporary failure
Realtime temporary disconnect
duplicate comment
viewer event without comment
comments without viewer event
double DISCONNECT
reconnect same room
```

---

## 31. Phase Gates

T0 Audit:
pipeline mapped.

T1 Provider Smoke:
direct provider can connect to a known LIVE account, OR an external blocker is proven.

T2 Simulator E2E:
simulated comments/viewer events reach UI.

T3 Real LIVE:
real room connection succeeds;
at least one real event observed;
viewer count observed if provider supports it.

T4 Persistence/Realtime:
events persist once and UI recovers on reconnect.

T5 Resilience:
timeouts/reconnect/dedup/disconnect work.

T6 Product Completion:
seller workflow is reliable and diagnostics exist.

---

## 32. Non-Goals

Do NOT add:
- Zalo;
- shipping;
- COD;
- Facebook LIVE;
- minigame;
- TikTok Shop checkout;
- SaaS billing.

Focus only on reliable TikTok LIVE.

---

## 33. Documentation

Update only if facts change:

```text
docs/architecture/INTEGRATIONS.md
docs/architecture/SYSTEM.md
docs/architecture/INVARIANTS.md
docs/engineering/TESTING.md
docs/verification/CURRENT.md
docs/ai/HANDOFF.md
```

Add:

```text
docs/runbooks/TIKTOK_LIVE_TROUBLESHOOTING.md
```

Troubleshooting sequence:

```text
1 listener health
2 provider smoke
3 username
4 is-live lookup
5 room-id
6 WebSocket
7 provider event
8 normalized event
9 DB ingest
10 Realtime
11 UI
```

---

## 34. Implementation Discipline

For each fix:

```text
RED
capture the failure

GREEN
smallest correct fix

REFACTOR
clean boundaries

VERIFY
focused tests + regression
```

No speculative rewrite.

---

## 35. Final Response

Return only:

```text
STATUS
PASS / PARTIAL / BLOCKED

ROOT CAUSE
<evidence-backed>

PIPELINE STATUS
Channel config:
Username normalization:
Listener:
Room lookup:
Provider connect:
WebSocket:
Comment event:
Viewer event:
Ingest:
DB:
Realtime:
UI:

CHANGED
<paths>

MIGRATION
<name or none>

TESTS
<summary>

REAL LIVE TEST
PASS / BLOCKED
evidence:

KNOWN PROVIDER LIMITATIONS
<short>

BLOCKERS
<only unresolved>

NEXT
<one safe action>
```

---

## 36. Stop Conditions

Stop and report BLOCKED if:
- no account is currently LIVE for real-provider test;
- provider requires missing credentials;
- external provider is rate-limited/unavailable;
- cloud test environment is unavailable;
- production mutation would be required.

Do not fake PASS.

---

## 37. Begin

Start with T0 Audit.

The goal is NOT to make the spinner disappear.

The goal is to prove exactly which layer fails, fix that layer, and verify the complete event pipeline.
