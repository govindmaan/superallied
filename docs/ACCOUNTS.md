# Accounts module

Tally remains the official books of account and the only GST invoicing system. The Accounts module stores
Tally documents that were already generated, records money actually received, issues payment receipts,
matches money to invoices, and tracks outstanding balances. It never creates GST tax invoices or accounting
vouchers, and uploading a PDF does not prove GST-portal or e-invoice validation.

## What was found in the existing app

- Express + EJS + Bootstrap 5, SQLite through `node:sqlite`, Puppeteer PDFs on the letterhead (`pdf.js`), `xlsx` for Excel.
- Customers, machine quotations (`quotations`, valued with `calcQuotation`), salespersons, roles in `role_permissions`, a shared `audit_log`.
- **There was no delivery challan module and no branch concept.** The module adds a delivery challan register
  (`acc_challans`) and a configurable branch list (Accounts → Settings).
- The existing `/uploads` folder is readable by any logged-in user, so accounts files are stored elsewhere (see Files).

## Screens (`/accounts`, sidebar section “Accounts”)

| Screen | Path | Who |
|---|---|---|
| Accountant Dashboard | `/accounts` | accountant, accounts manager, manager, admin |
| Upload Tally Invoice → Review → Confirm | `/accounts/invoices/upload` | accountant, accounts manager |
| Generate Receipt | `/accounts/receipts/new` | accountant, accounts manager |
| Customer Accounts / customer ledger & statement | `/accounts/customers[/:id]` | all above; sales: own customers only |
| Payment Entry (payments, cheque clearance, verification) | `/accounts/payments` | accountant, accounts manager, manager |
| Payment Allocation | `/accounts/allocations` | accountant, accounts manager |
| Invoice Register / invoice page | `/accounts/invoices[/:id]` | all above; sales: own customers only |
| Delivery Challans | `/accounts/challans` | all above; sales: own customers only |
| Delivery Challan Reconciliation | `/accounts/reconciliation` | accountant, accounts manager, manager |
| Collection Register (cash / bank / UPI / cheque tabs + daily summary) | `/accounts/collections` | accountant, accounts manager, manager |
| Outstanding Reports (17 reports, PDF / Excel / CSV) | `/accounts/reports` | accountant, accounts manager, manager |
| Approvals & Verification | `/accounts/approvals` | accountant (view), accounts manager |
| Audit Log | `/accounts/audit` | accounts manager, manager, admin |
| Accounts Settings | `/accounts/settings` | admin |

Accountants and accounts managers land on the Accounts dashboard when they open Home.

## Roles and permissions

New roles `accountant` and `accounts_manager` (Users → New User, or HR → Employees). Permissions are seeded in
`role_permissions` and enforced on the server in `services/accounts/engine.js` for every write, and by
page guards in `routes/accounts.js` for every read. Hidden buttons are only a convenience.

| Permission | Meaning | Seeded for |
|---|---|---|
| `accounts_view` | Read invoices, receipts and balances of customers the user created or quoted | sales, staff, office (+ all accounts roles) |
| `accounts` | Upload/edit unverified invoices, record payments & receipts, allocate, request cancellations/adjustments, resolve reconciliation flags, reports | accountant, accounts_manager |
| `accounts_approve` | Verify invoices and payments, edit verified records, approve/reject receipt cancellations and adjustments, reverse allocations, cancel invoices/challans | accounts_manager |
| `accounts_reports` | Read-only dashboard, registers, reports and audit log for all customers | manager |
| admin (`*`) | Everything, plus Accounts Settings | admin |

## Money and accounting rules

- **Amounts are INTEGER paise** (₹1 = 100) everywhere in the accounts tables — exact, no floating point.
  SQLite has no DECIMAL type; integer minor units are the fixed-precision equivalent. Input is parsed by
  `toPaise()` (max 2 decimals, no negatives).
- A **payment** (`acc_payments`) is money received. Its **allocations** (`acc_allocations`) match it to invoices.
  Stored and kept in the same transaction: `amount`, `allocated_amount`, `unallocated_amount` on payments;
  `total_amount`, `allocated_amount`, `balance_amount` on invoices. CHECK constraints keep `unallocated = amount − allocated`
  and `balance = total − allocated`, and allocations can never exceed either side.
- Money not yet allocated is the customer’s **advance / credit balance**. An overpayment simply stays unallocated.
- **Quotation advance**: recorded with the quotation, never allocated at entry; allocate it from Payment Allocation once the Tally invoice is uploaded.
- **Cheques**: `received → deposited → cleared | bounced`. Allocations from an uncleared cheque are `pending`: they reserve
  the invoice balance but do not reduce it. Clearing activates them; bouncing reverses them and opens a cancellation request for the receipt.
- **Credit notes** are uploaded like invoices; one linked to an original invoice is applied to it on confirmation. Unused credit can be allocated later.
- **Invoice status**: lifecycle `draft → uploaded → verified` (or `cancelled`) plus payment status
  `unpaid / partial / paid / credit_adjusted`. Overdue is computed (due date passed and balance > 0). “Paid” is never set by hand —
  only by allocations, or by a **controlled adjustment** (round-off, write-off, discount, TDS) that a second person approves.
- **Receipt cancellation** needs a reason; accountants’ requests wait for an accounts manager (configurable). Approving reverses all
  allocations, marks payment and receipt cancelled, issues a cancellation number (`SA/RCN/26-27/0001`) and keeps the original receipt PDF.
- **Duplicate invoices**: unique on (Super Allied GSTIN, financial year of the invoice date, document type, number), case-insensitive.
- **Numbering**: receipts `SA/RCT/<FY>/<0001>` from `acc_sequences`, incremented inside the payment transaction; prefix in Settings.
- **Concurrency / double submits**: every write is one `BEGIN IMMEDIATE` transaction that re-reads balances under the lock; forms carry a
  one-time `client_token` (unique), so a double click returns the same receipt/draft.

### Ledger convention (customer account and statement)

Debit = Tally tax invoices, debit notes, and reversal of a cancelled/bounced receipt. Credit = money received, credit notes, approved
adjustments. Balance = Debit − Credit: **Dr** = receivable from the customer, **Cr** = advance held for the customer. Allocations do not
change the balance. Quotations and challans are not ledger entries.

### Dashboard

Quotation value, advances, challan value and Tally invoice value are shown side by side as **stages of the same sale and never added
together**. Outstanding, overdue and unallocated figures are positions as of today; collection and upload figures follow the date filter.

## Database tables (created in `services/accounts/schema.js`, run from `db.js` at start-up)

| Table | Purpose |
|---|---|
| `acc_challans` | Delivery challan register (links customer, quotation, machine) |
| `acc_invoices` | Uploaded Tally documents with totals, allocated and balance, statuses |
| `acc_invoice_challans` | Many-to-many invoice ↔ challan |
| `acc_invoice_files` | Every file revision (never overwritten), SHA-256 |
| `acc_payments` | Money received, cheque clearance and verification fields |
| `acc_cheque_events` | Cheque status history |
| `acc_receipts` | One receipt per payment, unique number, stored original PDF |
| `acc_allocations` | Payment / credit note / adjustment → invoice, `active / pending / reversed` |
| `acc_adjustments` | Controlled write-off / round-off requests and approvals |
| `acc_cancellations` | Receipt cancellation requests, decisions, reversal snapshot |
| `acc_discrepancy_resolutions` | Reconciliation flags resolved with remarks |
| `acc_sequences` | Per-FY receipt and cancellation numbering |

Existing tables reused: `customers`, `quotations`, `machines`, `salespersons`, `users`, `settings` (keys `acc_*`),
`role_permissions`, `notifications`, and `audit_log` (entities `acc_*`, `details` = JSON with `before` / `after` / `reason`).
Migrations are additive (`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`) — no existing data is changed.

## Files

Uploaded invoices (PDF/JPG/PNG, size limit in Settings, checked by extension **and** file signature) and receipt PDFs are written with
random names and mode 600 to `ACC_FILES_DIR` (default `<folder of DB_PATH>/private/accounts`) — outside the public `/uploads` folder —
and served only through `/accounts/...` routes after a permission check, with `Cache-Control: private, no-store`.

PDF text reading (`services/accounts/files.js`) is best effort for text-based Tally PDFs: it suggests number, date, GSTIN, taxable value,
tax and total, shown as “unverified” with a Use button. Scans and CID-font PDFs yield no suggestions; no OCR service is connected.

## Security

- Server-side permission checks on every route and engine call; salespeople are scoped to their customers.
- CSRF token (session-bound) on every POST under `/accounts` (form field `_csrf` or `X-CSRF-Token` header).
- Parameterised SQL only; enum and id inputs validated.
- Audit log never stores passwords or tokens.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `ACC_FILES_DIR` | `<dir of DB_PATH>/private/accounts` | Private storage for invoices and receipt PDFs. On Railway the default is inside the `/app/data` volume, so files persist. |
| `ACC_RECEIPT_PDF` | (on) | `off` skips storing the receipt PDF at creation (tests); it is then made on first download. |

## Deployment

1. Push to `main` (Railway builds the Dockerfile). Start-up creates the new tables and permissions automatically.
2. Back up first (Backup & Restore). The plain database backup has records only; **Export all** (database + files) now also includes
   the private accounts files under `private/accounts/` in the archive. To restore files on a new server, copy that folder to `ACC_FILES_DIR`.
3. Admin: create users with the **Accountant** / **Accounts Manager** roles; check Accounts → Settings (receipt prefix, approval rule, branches, challan days).
4. Check company name, address, GSTIN and phone in Settings — they print on receipts.

## Tests

`npm test` runs `test/accounts.test.js` (scenarios A–I plus cheque, credit note, adjustment, idempotency, money parsing) and
`test/accounts-routes.test.js` (HTTP permission checks, CSRF, export = screen). Scenario I runs two worker threads with separate
SQLite connections allocating the same payment at the same instant. Scenario C in the brief lists ₹40,00,000 + ₹60,00,000 against a
₹10,00,000 invoice; the test uses ₹4,00,000 + ₹6,00,000, which is what the scenario describes.

## Not included / limits

- No bank statement import or bank feed: bank matching is manual (bank reference, credit date, verification).
- No Tally integration (no XML/ODBC sync); invoices are uploaded as files plus keyed values.
- No OCR for scanned images.
