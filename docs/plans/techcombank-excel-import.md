# Techcombank Excel bank statement import — audit of the supplied workbook

**Status, 12/10/2026:** Excel-specific audit and analysis only; no Excel adapter, migration or database data was changed for this sample. The separate shared import UI now presents **Lịch sử nhập sao kê** for Excel/PDF, but the Excel parser and staging privacy gaps below remain. The private sample was read locally; examples suppress account, customer, counterparty, reference, description, and exact monetary values. This document describes **one verified workbook layout**, not every Techcombank Excel export. The requested Excel implementation stops at this review gate.

## CURRENT FINDINGS

- The current route is **Tài chính → Thu Chi → Nhập sao kê** (`src/pages.jsx`, `src/features/BankStatementImport.jsx`). Excel parsing is local through `read-excel-file` (`src/lib/bank-statement-file.js`), followed by preview, manual column mapping, staging, account/category selection, and owner/manager confirmation. The browser does not upload the `.xlsx` file itself.
- The supplied workbook **cannot pass the current Excel reader**: its decoded sheet reaches 65 columns, while the reader rejects anything above 50 (`Sao kê vượt quá 50 cột.`). The real transaction header is at row 34, is bilingual, and does not match the current exact header hints. Reading all rows after row 34 would also encounter page footers, totals, and a separate CCTG table.
- Thu Chi has one voucher table, `public.cash_transactions`, and one authoritative cash ledger, `public.cash_movements`. `public.expense_categories` supplies Nhóm thu chi and `public.cash_accounts` supplies Tài khoản tiền. Migration `016_bank_statement_import.sql` already provides batches, staged rows, duplicate hints, classification, and atomic/idempotent posting through `post_cash`. Local migration `021_pdf_bank_statement_guard.sql` additionally broadens the pending-row duplicate probe across visible batches; its deployment to Supabase has not been verified here.
- The existing Excel route sends `raw_row` (the entire decoded worksheet row) and the original filename to the staging RPC. For this layout, `raw_row` would include **Đối tác**, **NH Đối tác**, and **Số dư**; the server accepts that JSON without a field allowlist. This is a verified privacy gap to close before supporting the sample.
- A bank credit/debit establishes cash direction only. Profit meaning comes from the chosen, active, same-direction Nhóm thu chi or a verified linked ERP document. The existing confirmation creates and posts a new cash voucher; it does not link an existing voucher or skip a row.

Sources inspected: `docs/AGENTS.md`, the real `docs/SaoKeTK_15092026_20092026.xlsx`, `src/forms.jsx`, `src/pages.jsx`, `src/features/BankStatementImport.jsx`, `src/lib/bank-statement-file.js` and its tests, `src/lib/repository.js`, migrations `001`, `014`–`016`, `019`, `021`, and `scripts/test-bank-statement-import.mjs`. The workbook was examined in memory with the repository's Excel reader and ZIP/XML metadata; no raw personal or banking content was printed.

## REAL EXCEL STRUCTURE

| Property | Observed result |
|---|---|
| Workbook/sheet | One worksheet; its bank-generated name is withheld because it can encode account information. The XML dimension is `A1:BS89` (89 indexed rows, 71 indexed columns). The reader returns 87 rows, width 65, with 41 nonempty rows; row 87 is the last populated row. |
| Layout | A print-style export with **140 merged ranges**, sparse values, repeated page footer blocks, and many styled empty cells. There are **no formulas** in the worksheet XML. |
| Statement context | Metadata and sensitive account/customer information occupy the upper area. The displayed period is **15/09/2026–20/09/2026**. These cells are context, not transactions. |
| Standard TKTT table | Header row **34**. Columns: `B` Ngày giao dịch; `H` Đối tác; `Q` NH Đối tác; `Y` Diễn giải; `AG` Số bút toán; `AT` Nợ TKTT; `BB` Có TKTT; `BH` Số dư. Opening balance row **35**. Transaction rows **36, 38, 40, 42, 44, 51, 53**. Total debit/credit row **55** and closing balance row **56**. |
| Continuation/footer | A page footer at row **47** interrupts the normal transaction list; rows **51** and **53** still belong to that table. Other footer/signature material occurs around rows **65** and **87**. Empty styled rows are not transactions. |
| Separate CCTG section | Introductory material around rows **74–79**, a different header at **81**, and two populated data rows **82, 84**. Its columns include `Biến động TKTT` and `Giá trị CCTG phân bổ`. Per ChiDi's decision, this section is **excluded entirely** from Thu Chi import and staging. |
| Dates and amounts | Transaction dates are text in `dd/mm/yyyy`; the standard table includes 16–18/09/2026 and **21/09/2026**. The last date is outside the displayed period and needs a preview warning, not silent deletion. Populated debit/credit cells are comma-grouped positive integer strings with no decimal part; the other side is blank. |
| Text/reference | All seven standard rows have a `Số bút toán` value (two observed structural variants: fixed alphanumeric code, optionally followed by a suffix). Standard `Diễn giải` values have no embedded newline in this sample; headers and footer text are multiline. Some descriptions contain long digit runs, so raw content must never enter logs/docs or unreviewed auxiliary fields. |
| Reconciliation | Seven standard rows: **four debit and three credit**, none with both/neither side populated. Their debit and credit sums separately equal row 55, and `opening + credit − debit = closing` matches the displayed balance. These checks were done in memory without recording actual balances or amounts. |

## TRANSACTION TABLE DETECTION

For this sample, a proposed `TechcombankExcelStatementAdapter` should implement `canParse`, `detectTransactionTable`, `detectColumns`, `parseTransactionRows`, `normalizeTransaction`, and `validateTransaction` over the existing local reader. `canParse` must require the standard TKTT header's **combination** of date, description, reference, debit, credit, and balance labels, not a filename or fixed row number alone. The detected column anchors for the sample are `B/Y/AG/AT/BB` plus `BH` for transient reconciliation. A changed or ambiguous header must fail closed.

Start after the verified header and read only date-anchored rows with a description and exactly one positive debit/credit cell. Permit blank/styled lines and the page footer at row 47; do **not** stop at that footer. Stop at the verified `Cộng doanh số/Total volume` row 55, before the closing balance and later CCTG header. Row 35 is an opening balance, not a transaction. Row 55 is a total, not a transaction. Rows 82/84 must not be interpreted with the standard table's debit/credit mapping. Preserve the real worksheet row number as source position.

The current reader's 50-column cap must be addressed without making all 71 formatted columns financial data. An adapter can inspect only the required anchors after a bounded sheet read. This document does not authorize a larger unbounded generic importer.

## EXCEL FIELD CLASSIFICATION

`IMPORT` means only the specified transaction cell may enter the normalized candidate. `DERIVE` is calculated locally. `OPTIONAL` requires presence and a specific need. `IGNORE` means no persisted transaction field. All examples are redacted or structural.

| Excel field/location | Example redacted | Class | Normalized field | Reason |
|---|---|---|---|---|
| Standard row `B`, Ngày giao dịch | `16/09/2026` | IMPORT | `transaction_date` | Business date shown for each bank movement; flag the observed out-of-period row. |
| Standard row `Y`, Diễn giải | `[transaction description]` | IMPORT | `description` | Required voucher content, bounded and reviewed. Do not append other worksheet text. |
| Standard row `AG`, Số bút toán | `[bank reference]` | OPTIONAL | `external_reference` | Present in all seven sample rows; useful duplicate evidence, not assumed globally unique. |
| Standard row `AT`, Nợ TKTT | `[integer amount]` | IMPORT | `debit_amount` → `out`, `amount` | Only one positive side may be populated. |
| Standard row `BB`, Có TKTT | `[integer amount]` | IMPORT | `credit_amount` → `in`, `amount` | Only one positive side may be populated. |
| Standard row `H`, Đối tác | `[counterparty redacted]` | IGNORE | — | Counterparty identity is not required by the present Thu Chi voucher. |
| Standard row `Q`, NH Đối tác | `[bank redacted]` | IGNORE | — | Unneeded third-party/bank information. |
| Standard row `BH`, Số dư | `[balance redacted]` | IGNORE | — | Use only transiently for local arithmetic consistency; never a voucher amount. |
| Source worksheet row number | `36` | DERIVE | `source_row` | Traceability without keeping whole raw row. |
| Workbook bytes | `[hash only]` | DERIVE | `source_sha256` | Local SHA-256 identifies a repeated file; it is not server proof of bytes. |
| Period/account/customer metadata; sheet name; original filename | `[redacted]` | IGNORE | — | They are not transactions and can expose account or personal information. |
| Row 35 opening balance; row 55 totals; row 56 closing balance | `[redacted amount]` | IGNORE | — | Local comparison only; never create Thu Chi from these rows. |
| Page footers/signatures/notes; styled empty rows | `[nontransaction text]` | IGNORE | — | Outside the bank movement table. |
| Rows 81–84 CCTG fields | `[CCTG section]` | IGNORE | — | Separate business section explicitly excluded from this import. |

There is no verified separate posting/effective-date column in the standard table. There is no per-transaction currency column. Do not invent either field from a nearby metadata cell.

## PRIVACY ALLOWLIST

After the user continues from local preview, only these source-derived values should be eligible for staging: `transaction_date`, `description` (only cell `Y`), `direction`, integer `amount`, optional `external_reference` (cell `AG`), `source_row`, and `source_sha256`; bounded validation/warning **codes** can accompany a candidate. The selected ERP `account_id` and category are application decisions, not workbook identities. A neutral generated source label can satisfy the existing batch contract; the original filename is unnecessary.

Discard the original workbook bytes and unrelated cells after local analysis. The source `description` is itself sensitive and contains long digit sequences in this sample; mask it in logs/errors and show it only to authorized reviewers. `raw_row` must be a server-enforced allowlisted object or empty/minimal provenance, never the full array returned by the Excel library. Full account numbers and account-holder details must not be copied from headers into Tài khoản tiền or `provenance`.

## DATA THAT MUST NOT BE IMPORTED

Do not persist the customer/account holder name, address, contact/profile/identity details, full bank account number, bank branch or counterparty bank, remitter identity, worksheet name or metadata, original filename, running/opening/closing balances, report debit/credit totals, headers, footer/signature prose, unrelated notes, formatting, images, or any CCTG rows/fields. Bank totals and balances may be read **transiently in memory** to check extraction. No original `.xlsx` upload or external AI processing is needed.

## EXISTING THU CHI FIELDS

The one existing `DocumentForm` (`src/forms.jsx`) handles both Tạo phiếu thu and Tạo phiếu chi by `direction`; it saves a draft with `create_cash`. The transaction list shows/edit drafts, posts with owner/manager rights, and reverses/corrects posted vouchers through existing RPCs. The import screen currently has its own compact classification controls, not a call into this form.

| Thu/Chi field | Source for Excel candidate | Auto fill? | User editable? | Required? | Rule |
|---|---|---|---|---|---|
| Loại giao dịch / `direction` | Debit=`out`, credit=`in` | Yes, as proposal | In draft; source correction must be audited | Yes | Never equate `in` with revenue or `out` with expense. |
| Ngày thực tế / `transaction_date` | Column `B` | Yes, as proposal | In draft | Yes to post | Actual calendar date; review 21/09 row outside report period; after account opening. |
| Ngày ước tính / `date_estimated` | User verification | Default false only after verified extraction | In draft | Must be false to post | Do not post an uncertain date. |
| Nội dung / `description` | Column `Y` | Yes, as proposal | In draft | UI requires nonblank; max 500 | Preserve necessary meaning; reject/ask edit if source exceeds form limit. |
| Tài khoản tiền / `account_id` | Existing `cash_accounts` | No | User selects | Yes to post | Same workspace, opening balance/date confirmed. Workbook account identity is not stored as a second account system. |
| Nhóm thu chi / `category` | Existing `expense_categories` | No authoritative auto-choice | User selects | Yes to post | Active, same direction; `category_kind` and `profit_eligible` control business treatment. |
| Số tiền / `amount` | Exactly one of `AT` or `BB` | Yes, as proposal | In draft | Yes | Positive integer VND in `1..9,000,000,000,000`, revalidated on server. |
| Ghi chú / `notes` | User/evidence | No | Yes | No | UI max 4,000; never dump whole worksheet or counterparty metadata. |
| Bank reference, source hash/row / `provenance`, `source_id`, `import_row_hash`, `legacy_id` | `AG`, local SHA-256, row index | System metadata | No normal direct edit | Needed for import traceability | Existing import RPC writes these; no new normal form field is required just to retain reference. |
| `id`, `workspace_id`, `status`, `created_by`, `created_at`, `updated_at` | Server/auth/RPC | System | No | System | Draft/posted/reversed/deleted lifecycle; workspace and actor cannot come from Excel. |
| Delete/correction, posting/reversal and audit metadata | Existing RPCs/tables | System | Through authorized actions only | Conditional | Posted cash has immutable movement/category snapshot; correction is reversal/replacement. |

## EXCEL → NORMALIZED TRANSACTION MAPPING

| Excel | Normalized | Thu/Chi field | Auto/User | Required | Validation | Import? |
|---|---|---|---|---|---|---|
| `B` date text | `transaction_date` ISO date | `transaction_date` | Auto proposal, user reviews | Yes | Strict `dd/mm/yyyy`, real calendar date, period warning | Yes |
| `Y` details | `description` | `description` | Auto proposal, user edits | Yes | 1–500 characters for present form; avoid leaking identifier runs | Yes |
| `AG` transaction no | `external_reference` | Staging/reference provenance | Auto | Optional | At most 200 chars; literal source ref, not unique by assumption | Yes if present |
| `AT` debit | `direction=out`, integer `amount` | `direction`, `amount` | Auto proposal | Exactly one side | Comma grouping; positive whole number; safe integer/BigInt arithmetic | Yes |
| `BB` credit | `direction=in`, integer `amount` | `direction`, `amount` | Auto proposal | Exactly one side | Same as debit | Yes |
| Row index | `source_row` | Import provenance | System | Yes | Positive bounded worksheet row | Yes |
| `H`, `Q`, `BH`, metadata, CCTG | — | — | None | No | Exclude before constructing server payload | No |

## NORMALIZED TRANSACTION → PHIẾU THU MAPPING

Only a validated **credit** candidate may prefill the existing `DocumentForm` with `direction='in'`, date, description, and amount. User selects the existing `cash_accounts.id` and an active `expense_categories` code with `direction='in'`; neither selection follows automatically from the bank credit. The bank reference and file/row trace belong in import provenance. The user checks any existing sales/COD/refund/capital/transfer document before allowing a new cash movement.

## NORMALIZED TRANSACTION → PHIẾU CHI MAPPING

Only a validated **debit** candidate may prefill that same form with `direction='out'`, date, description, and amount. User selects the existing account and an active outflow category; a supplier payment, inventory purchase, payroll payment, loan repayment, transfer, or operating cost needs evidence before its business meaning is chosen. A linked prior payment must not produce another cash movement or duplicate purchase/payroll expense.

## TẠO PHIẾU CHI GAPS

No new visible field is needed for **amount, date, content, group, or Tài khoản**: all exist. The current import screen does not open/prefill `DocumentForm`; it only lets users choose account/category and a duplicate reason on a staged row, then confirmation posts immediately. It cannot correct date, description, direction, or amount in staged review, cannot link an existing ERP document/voucher, and cannot skip a row. `Số bút toán` is already stored as staging `external_reference` and posted `provenance`, but has no dedicated visible review field in the normal form. These are workflow/UI gaps, not proof that a new financial ledger or bank-account table is needed.

## TẠO PHIẾU THU GAPS

The same form and staging limitations apply to credits. In particular, a bank credit cannot be automatically labelled sales revenue, and the current confirm RPC cannot reconcile an existing sales/COD/cash receipt instead of creating a new posted voucher. A reviewed link/skip outcome and audit are needed for the complete requested workflow; their precise schema contract should be settled only after this audit is reviewed.

## DUPLICATE STRATEGY

Locally mark exact repeated candidates within the seven-row set using date, direction, integer amount, normalized description, and the reference when present. At staging/confirmation, compare within the same workspace against prior staged rows and existing `cash_transactions`, including manually created and posted vouchers; check exact reference first but do not treat it as sufficient alone. The local `021` duplicate function inspects other **pending** visible batches when deployed, whereas `016` alone compares staged rows only inside the current batch. Same-file SHA-256 and request IDs already provide file/retry idempotency; the server still needs a verified disposition to distinguish `UNIQUE`, `POSSIBLE_DUPLICATE`, `EXACT_DUPLICATE`, and `ALREADY_LINKED`. Current `duplicate_override_reason` can acknowledge a possible duplicate and then post; it is not a link to an existing document. No silent duplicate import.

## CLASSIFICATION STRATEGY

Use `expense_categories` as the sole Nhóm thu chi catalog. Prioritize a verified existing ERP document/voucher, then a verified exact reference rule, then a user rule, then a description suggestion, then manual selection. The repository has no verified user-defined bank rule engine or linked-document workflow today, so suggestions must remain uncommitted until the user confirms them. Category choice determines `category_kind` and `profit_eligible`; debit/credit alone never does. Internal transfers require a reviewed cash-movement policy so they do not appear as fake profit or duplicate both sides.

## RECONCILIATION STRATEGY

Before staging, display standard TKTT transaction count **7**, debit count **4**, credit count **3**, invalid/warning/duplicate counts, and debit/credit totals calculated with integer arithmetic. Compare the two calculated totals with row 55 and optionally check opening + credit − debit = closing **locally**; the inspected sample passes all three comparisons. Do not persist or display account balances as Thu Chi data. Flag the row dated **21/09/2026** because it lies outside the displayed 15–20/09 period, while retaining it for review because the reported totals include it. Exclude the two CCTG rows from all import-ready and Thu Chi sums. After confirmation, reconcile `created + linked + skipped + pending` with the seven candidates, and confirm every created voucher has exactly one original `cash_movements` post. The current UI only shows a combined absolute selected amount; separate debit/credit reconciliation is missing.

## SECURITY RISKS

1. **Raw row retention:** Excel UI currently stages the full `raw_row` array; `016` checks only JSON shape/length, then returns it to members through `get_bank_statement_import`. This would persist remitter, bank, and running balance in the sample. Server-side allowlisting is required; client filtering alone is insufficient.
2. **Overbroad reads:** Excel batches/rows under `016` are visible to owner/manager/staff/viewer within the workspace. Descriptions may expose payroll or customer information even if other HR-linked cash views are restricted by `019`. Review row, voucher, movement, snapshot, audit, and report visibility end to end.
3. **Untrusted input:** The server validates normalized dates/amounts and workspace account/category, but it cannot prove the supplied row equals the local workbook bytes. A browser SHA-256 is a dedupe identifier, not source attestation. Neutralize original filename, bound descriptions/references, and avoid reflecting parser/library raw content in errors.
4. **Accounting duplication:** The current confirm RPC always creates and posts a new voucher. Existing sales, purchase, COD, payroll, transfers, and manually entered cash may already represent the event. Linking or skipping must create zero additional cash or profit effect.
5. **Source ambiguity:** Printed sections, page footers, and CCTG have different headers. A naive full-sheet parse can turn balances/totals/CCTG into vouchers. The out-of-period date also needs visible review.

## SCHEMA GAPS

| Gap | Verified state | Migration needed for complete requested workflow? |
|---|---|---|
| Account and category | `cash_accounts` and `expense_categories` already exist; `account_id` is already on cash voucher and staged row | **No** for manual selection. No full bank-account number should be added from this file. |
| Reference/provenance | `external_reference`, source hash, row number, and cash `provenance` already exist | **No** for basic traceability. |
| Strict Excel payload/privacy | `016` accepts arbitrary `raw_row` and original `source_name`; broad member read | **Likely yes**: an additive, server-enforced Excel intake/allowlist and reviewed read policy. Do not edit historical `016`. |
| Staged correction and disposition | Staged row permits only account/category/duplicate reason; status is pending/confirmed; confirm always posts | **Yes** for persisted edit audit, link-existing/skip outcomes and safe confirmation, if the complete review workflow is approved. Extend existing tables/RPCs, not a second ledger. |
| Duplicate lookup across batches | `021` locally extends pending-row comparison with privacy filters; actual deployment unverified | **No new table proven**; verify installed migration and add focused tests before deciding. |
| Currency | No per-row currency field; current cash amount is integer VND | **No inferred schema change** for this sample; VND must be verified before posting. Unsupported currency remains blocked. |

## IMPLEMENTATION ORDER

1. **E1–E3 complete in this document:** repo/Thu Chi audit; actual workbook structure; field and form mapping.
2. **Review gate:** confirm privacy allowlist, exact standard-table scope, CCTG exclusion, role visibility, and the out-of-period warning. Stop here as requested.
3. **E4–E5 after review:** write a sanitized structural fixture and bank-specific detector/adapter; prove it extracts seven standard rows, handles footer continuation, and excludes balances/totals/CCTG. Keep bounds and local file hash.
4. **E6–E8:** update local preview to the requested columns, separate debit/credit reconciliation, row actions, account/category classification, duplicate evidence, and linked/skip decisions using existing ERP data.
5. **E9–E10:** prefill the existing Thu Chi form and add only necessary additive server changes for allowlisted staging, trusted validation, audited correction/link/skip, and idempotent confirmation through `cash_transactions`/`post_cash`.
6. **E11–E12:** verify count/sums/outcomes and test parsing, privacy, finance semantics, RLS/workspace isolation, tampering, retries, and concurrent confirmation with sanitized fixtures. Run existing DB/UI/build checks and a separate test-Supabase smoke check before production consideration.

## BLOCKERS

- This task explicitly stops after the audit document; no E4+ implementation is authorized in the current phase.
- The real workbook is currently rejected by the 50-column reader limit, so there is no working import for this sample yet.
- The displayed period ends 20/09/2026 but one standard transaction is dated 21/09/2026; its source meaning requires user review. The sample does not provide a per-row currency column, so VND must be confirmed from the statement context.
- The current Excel RPC/UI cannot satisfy the privacy allowlist, link-existing, skip, and editable review requirements. PDF migrations `021` and `022` exist locally, but their state on a real Supabase project is unverified; neither migration implements the Techcombank Excel adapter.

## NEXT SAFE ACTION

Review this document and approve the seven-row TKTT scope, CCTG exclusion, privacy allowlist, and treatment of the 21/09/2026 row. Then implement E4+ with a sanitized fixture and an additive server path; test on a nonproduction Supabase project before any real statement is staged.
