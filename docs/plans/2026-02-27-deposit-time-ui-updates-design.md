# Design: Deposit Time Field + UI Updates

Date: 2026-02-27

## Changes

### 1. Deposit Time Field (deposit_time)

Add `deposit_time TIME NULL` to `Requests` table. Required for new submissions, NULL for backward compatibility with existing records.

- **Format**: HH:MM:SS via `<input type="time" step="1">`
- **Required**: Yes (enforced server-side for both public and admin creation)
- **Placement**: Next to deposit_date in the same grid row

Affected files:
- `src/schema.sql` — ALTER TABLE migration
- `src/server.js` — validation, INSERT, UPDATE for public/admin routes
- `public/index.html` — time input in both refund and misdeposit forms
- `public/js/admin.js` — DataTables column, detail/create/edit modals, Excel export
- `CLAUDE.md` — schema docs

### 2. Header Title Change

`index.html` nav title: "신청 Form" → "오입금 신청"

### 3. Tab Size and Centering

Current: `px-5 py-3 text-sm`, left-aligned
New: `px-8 py-4 text-base`, centered (`flex justify-center`)

Both tab buttons updated identically.
