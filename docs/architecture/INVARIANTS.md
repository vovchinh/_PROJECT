# ERP invariants

1. Preserve `products.id` and `product_variants.id = products.id`; editing a SKU does not rewrite old purchase/sale snapshots or FIFO costs.
2. Referenced product/category records are archived instead of deleted. An active stock reservation blocks product archive, and new business use of an archived SKU is rejected by database triggers.
3. Draft receipt/cash documents may be edited. Posted documents and their movements are not edited directly; their reversal adds dated compensating effects with actor and reason.
4. `available = on_hand − reserved order allocations − active manual/live reservations`; a reservation is not a stock movement.
5. Cash movement does not imply accounting expense or sale revenue. Purchase cash and COD receipts must not inflate managerial profit.
6. Each sensitive mutation is scoped to the authenticated workspace and audited. Client-side filters or buttons never substitute for RPC authorization.
7. Employee profiles are separate from Auth users. HR PII, attendance, leave, contracts and payroll are owner/manager data under RLS; general audit rows do not expose HR personal values.
8. A scheduled shift without confirmed attendance blocks payroll calculation; unrecorded work is not guessed as absence. A confirmed attendance correction records a reason and before/after snapshot.
9. Contract and period policies supply the monthly work divisor and overtime factor. No global 26-day divisor, tax or social-insurance formula is inferred. Paid leave types are explicit per contract.
10. Approval freezes payslip source snapshots and recognizes gross salary expense once. Salary advances and settlement are cash effects in the existing ledger, never a second payroll expense. Approved lines and linked cash vouchers cannot be raw-edited or reversed independently.
11. Additional allowance, bonus, commission and deduction amounts require owner/manager confirmation, a reason and audit; commission also requires a source reference. Only active components enter server calculation. Approved components are immutable.
