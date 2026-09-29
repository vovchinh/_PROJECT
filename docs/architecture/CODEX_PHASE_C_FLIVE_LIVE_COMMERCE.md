# CODEX — PHASE C: TikTok LIVE Commerce + Chốt đơn + In bill

Read `AGENTS.md` first.
Use current V2 audit/migration docs as context.
Do not restate architecture already documented.

This task implements ONLY Phase C.
Do not implement Phase D Zalo automation/deposits/final customer confirmation,
Phase E carrier APIs, or Phase F COD settlement.

CURRENT SOURCE OF TRUTH:
repo + current migrations + passing tests.

Never edit historical migrations 001/002/003.
Use new additive migrations only.

# PRODUCT GOAL

Build a FLIVE-inspired but ChiDi-safe mobile-first LIVE workflow:

TikTok LIVE
→ connect/session
→ realtime comments
→ deterministic parser suggestion
→ seller review
→ CHỐT & IN
→ atomic Live Sale Ticket
→ Campaign Customer STT
→ Customer Cart/Basket
→ Print Job
→ reprint/void
→ session history

Critical invariants:
- COMMENT != SALE
- PARSER != SALE
- DRAFT/CANDIDATE != SALE
- CHỐT & IN = COMMIT
- PRINT FAILURE != SALE FAILURE
- REPRINT != NEW SALE
- VOID != DELETE
- Authoritative actor = auth.uid(), never browser actor_id.

# 1. LIVE Home

Build mobile-first LIVE home:
- TikTok active; Facebook disabled/deferred.
- account/profile selector.
- tabs: LIVE / Đơn đã tạo.
- connect/disconnect.
- states: OFFLINE / CONNECTING / LIVE / RECONNECTING / ERROR.
- session duration, comment count, committed ticket count, printer health.
- STT panel: current customer count, next STT.
- reset STT only before campaign starts and with permission.

STT belongs to Live Campaign, not global customer identity.

# 2. Live Campaign + Session

Create:
- live_campaigns
- live_sessions
- live_campaign_customers

One Campaign may contain multiple Sessions.
Same customer keeps same operational STT across sessions of a campaign.

Do not destructively "merge live".
ChiDi "Gộp LIVE" = sessions linked to one campaign.

# 3. Comment feed

Create normalized comment contract and storage.

Minimum:
workspace_id
campaign_id
live_session_id
provider
external_comment_id
external_user_id
username
display_name
avatar_url
text
created_at
raw_payload
status

Deduplicate by workspace + provider + external_comment_id.

Statuses:
NEW
PARSED
READY
CLAIMED
COMMITTED
IGNORED
AMBIGUOUS
OUT_OF_STOCK
INVALID

Start with Manual/Simulator provider.
Real TikTok provider remains behind an adapter.

# 4. Parser

Deterministic-first parser:
- product alias/code
- color
- size
- quantity
- confidence
- ambiguous result
- available stock preview

Parser output is suggestion only.
Never reserve stock from parser output.

Add >=100 Vietnamese livestream parser tests.

# 5. Order candidate UI

Parsed comment card:
- customer/avatar
- username
- raw comment
- suggested product
- variant
- qty
- price
- available stock
- confidence

Actions:
[CHỌN LẠI]
[BỎ QUA]
[CHỐT & IN]

Pre-commit UI may show "Đơn nháp" or "Gợi ý".
It must NOT be stored as Final Order or authoritative sale.

# 6. CHỐT & IN

Implement authoritative RPC:

commit_live_sale_ticket()

Atomic transaction:
1 verify auth.uid()
2 verify permission/workspace
3 verify active campaign/session
4 lock/claim comment
5 resolve/create Campaign Customer + STT
6 resolve/create Customer Cart
7 lock authoritative inventory
8 calculate AVAILABLE
9 reject insufficient stock
10 create Live Sale Ticket
11 create Cart Item
12 create unified Inventory Reservation
13 create one business Print Job
14 append Audit
15 append Outbox
16 set comment COMMITTED
17 commit

Require durable idempotency_key.

Same key + same payload:
return same result.

Same key + different payload:
reject.

# 7. Live Sale Ticket

Create immutable business evidence with:
workspace_id
campaign_id
live_session_id
customer_cart_id
customer_id
campaign_customer_id
source_comment_id
parse_result_id
ticket_no
product_id
variant_id
product_code_snapshot
product_name_snapshot
variant_snapshot
quantity
unit_price
line_total
status
committed_by
committed_at
voided_by
voided_at
void_reason
idempotency_key

Status:
COMMITTED
VOIDED

Never hard-delete committed tickets.

# 8. Customer Cart / Basket

Ticket-derived cart UI inspired by FLIVE:
#027
display name / username
items
total quantity
temporary total
session/time
notes
print status

Actions:
[IN LẠI]
[VOID ITEM]
[XEM GIỎ]
[TỔNG ĐƠN]

During Phase C, TỔNG ĐƠN is read-only summary only.
No deposit/Zalo confirmation/final-order conversion yet.

Do not merge original ticket rows in DB.
UI may aggregate identical variants for display.

# 9. Session history

Build mobile history:
- date range
- platform filter
- grouped by day
- campaign/session duration
- account/channel
- session status
- ticket count
- customer count
- product qty
- temporary committed value

Session detail tabs:
[Đơn đã tạo]
[Tất cả bình luận]

Customer detail sheet:
[Thông tin]
[Đơn hàng]

Phase C customer info is read-only/basic existing V2 customer data.

# 10. Print architecture

Create:
- print_jobs
- print_attempts
- printer_devices
- printer_profiles
- print_templates

Separate business Print Job from physical attempts.

One committed ticket:
one business LIVE_SALE_TICKET print job
many audited attempts.

Document types:
LIVE_SALE_TICKET
CART_SUMMARY
SHIPPING_LABEL

Only LIVE_SALE_TICKET is required operationally in Phase C.

Print status:
QUEUED
CLAIMED
PRINTING
PRINTED
FAILED
CANCELLED

# 11. Printer settings UI

Mobile-first settings:
Printer type:
- LAN/WiFi
- Bluetooth
- USB/System
- disabled options when runtime unsupported

Fields:
printer name
driver/protocol
IP
port
paper size
font size
copies
auto-cut if supported
encoding
template
default printer flag

Actions:
[TEST PRINT]
[CONNECT]
[DISCONNECT]
Optional: [TÌM MÁY IN]

Do not fake discovery in browser.

Driver abstraction:
- ESC_POS
- TSPL
- SYSTEM_PRINT
- MOCK

Native/mobile bridge may be incremental.

# 12. LIVE bill template

Default layout emphasizes:

#027
username
product code
color / size
quantity
price
ticket number
timestamp

Example:

------------------------
ChiDiPos
#027
@dieu2004

CV49
XANH / M
SL: 1
69.000đ

LS-001238
21:32:10
------------------------

Template settings:
show_customer_number
show_username
show_product_code
show_product_name
show_variant
show_qty
show_price
show_ticket_no
show_timestamp
font_scale_customer
font_scale_product

# 13. Printer failure invariant

DB commit happens before physical print.

If printer fails:
Ticket = COMMITTED
Cart item = ACTIVE
Reservation = ACTIVE
Print Job = FAILED

UI:
"Bill chưa in"
[IN LẠI]

Reprint must NOT create another ticket/cart item/reservation or alter quantity.

# 14. VOID

Implement:
void_live_sale_ticket()

Atomic:
- lock ticket
- verify COMMITTED
- mark VOIDED
- void cart item
- release reservation exactly once
- audit
- outbox
- realtime

Never delete.

# 15. Realtime

Use Realtime/Broadcast for UX:
COMMENT_RECEIVED
COMMENT_CLAIMED
TICKET_COMMITTED
TICKET_VOIDED
CART_CHANGED
PRINT_STATUS_CHANGED

Database remains source of truth.
Reconnect must refetch authoritative state.

# 16. Operational metrics only

Phase C may show:
- comments
- parsed
- committed tickets
- customers
- units
- temporary committed value
- print failures
- voids

Do not redefine existing ERP revenue/finance reports.

# SUBPHASE C0 — Foundations + read UX

Implement:
- campaign/session/STT
- normalized comments
- simulator/manual provider
- parser
- idempotency foundation
- outbox foundation
- printer schema
- printer settings
- print template
- history/session UI
- Live Home/Connect UI
- no CHỐT & IN mutation yet

Gate:
- migrations pass
- RLS pass
- parser tests pass
- comment dedupe passes
- printer mock/test-print passes
- existing V2 regression passes

# SUBPHASE C1 — CHỐT & IN

Implement:
- comment claim
- Live Sale Ticket
- Customer Cart
- Cart Item
- unified reservation integration
- commit_live_sale_ticket()
- print queue/attempt
- reprint
- VOID
- realtime
- Live operational UI

Mandatory tests:
1 double click → one sale
2 lost response + retry → one sale
3 same idempotency key + changed payload → reject
4 two staff same comment → one winner
5 two comments one available stock → one winner
6 no negative available stock
7 printer offline → committed data preserved
8 reprint → no business duplication
9 VOID → reservation released once
10 cross-workspace access blocked
11 actor derived from auth.uid()
12 full existing V2 regression passes

# PHASE C NON-GOALS

Do NOT implement:
- Zalo OA automation
- customer claim code
- deposit/cọc lifecycle
- customer confirmation
- cart → Final Order conversion
- carrier API
- shipping label generation
- COD settlement
- TikTok Shop checkout
- SaaS billing
- Facebook LIVE
- minigame

Disabled/deferred UI placeholders are allowed if clearly marked.

# CODE RULES

- Keep existing React JS/JSX conventions.
- No project-wide TypeScript rewrite.
- New schema = new migration.
- Never edit 001/002/003.
- Every workspace table gets RLS.
- Sensitive commands enforce permission server-side.
- External side effects use outbox.
- Never expose secrets in frontend.
- Reuse existing V2 customer/product/inventory IDs where compatible.
- Follow current repo structure; do not create a parallel app.

# TOKEN-SAVING OUTPUT

Do not repeat architecture.

At end of each subphase return only:

Status: PASS / BLOCKED
Changed: filenames
Migration: migration name
Tests: concise pass/fail summary
Blockers: only if any
Next: one safe next action

Update V2 architecture/verification docs only where facts changed.
Stop after the requested subphase.
