# Deposit Time Field + UI Updates — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add deposit_time column (HH:MM:SS), change header title to "오입금 신청", and enlarge/center form tabs.

**Architecture:** Three independent changes touching 5 files. Schema migration first (dependency for all data-layer changes), then server.js, then frontend in parallel. No new dependencies.

**Tech Stack:** MSSQL TIME type, `<input type="time" step="1">`, Express.js, vanilla HTML/JS, Tailwind CSS.

---

### Task 1: Schema Migration — Add deposit_time Column

**Files:**
- Modify: `src/schema.sql` (after line 153, in migration section 5)

**Step 1: Add migration SQL**

Add after the `request_type` migration block (line 153):

```sql
-- 4-6. deposit_time 컬럼 추가 (입금 시각 HH:MM:SS)
IF COL_LENGTH('Requests', 'deposit_time') IS NULL
ALTER TABLE Requests
ADD deposit_time TIME NULL;
```

**Step 2: Apply schema**

Run: `node src/dbPush.js`
Expected: Schema applied successfully, no errors.

**Step 3: Commit**

```bash
git add src/schema.sql
git commit -m "feat: add deposit_time TIME column to Requests table"
```

---

### Task 2: Server.js — Public POST /api/requests

**Files:**
- Modify: `src/server.js:44,439,468-486`

**Step 1: Add deposit_time to FIELD_LABELS**

At `src/server.js:48` (after `deposit_date` entry), add:

```javascript
    deposit_time: '입금시간',
```

**Step 2: Add deposit_time to required fields**

At line 439, change:
```javascript
const required = ['applicant_name', 'applicant_phone', 'deposit_date', 'deposit_amount', 'bank_name', 'refund_account', 'contractor_type', 'merchant_type'];
```
to:
```javascript
const required = ['applicant_name', 'applicant_phone', 'deposit_date', 'deposit_time', 'deposit_amount', 'bank_name', 'refund_account', 'contractor_type', 'merchant_type'];
```

**Step 3: Add deposit_time to INSERT query**

After line 470 (`.input('depositDate', ...)`), add:
```javascript
                .input('depositTime', mssql.Time, d.deposit_time)
```

Update the INSERT column list (line 484) from:
```sql
INSERT INTO Requests (request_code, request_date, deposit_date, deposit_amount, ...
VALUES (@requestCode, CAST(GETDATE() AS DATE), @depositDate, @depositAmount, ...
```
to:
```sql
INSERT INTO Requests (request_code, request_date, deposit_date, deposit_time, deposit_amount, ...
VALUES (@requestCode, CAST(GETDATE() AS DATE), @depositDate, @depositTime, @depositAmount, ...
```

**Step 4: Commit**

```bash
git add src/server.js
git commit -m "feat: add deposit_time to public request submission"
```

---

### Task 3: Server.js — Admin POST /api/admin/requests

**Files:**
- Modify: `src/server.js:805,831,845`

**Step 1: Add deposit_time to admin required fields**

At line 805, change:
```javascript
const required = ['applicant_name', 'applicant_phone', 'request_date', 'deposit_date', 'deposit_amount', 'bank_name', 'refund_account', 'refund_account_name', 'contractor_type', 'merchant_type'];
```
to:
```javascript
const required = ['applicant_name', 'applicant_phone', 'request_date', 'deposit_date', 'deposit_time', 'deposit_amount', 'bank_name', 'refund_account', 'refund_account_name', 'contractor_type', 'merchant_type'];
```

**Step 2: Add deposit_time to admin INSERT**

After line 831 (`.input('depositDate', ...)`), add:
```javascript
                .input('depositTime', mssql.Time, d.deposit_time)
```

Update the INSERT column list (line 845) to include `deposit_time` and `@depositTime` in same positions as Task 2.

**Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat: add deposit_time to admin request creation"
```

---

### Task 4: Server.js — PATCH /api/admin/requests/:id (Update)

**Files:**
- Modify: `src/server.js:933-945`

**Step 1: Add deposit_time to allowedFields**

At line 935, after `deposit_date: mssql.Date,` add:
```javascript
            deposit_time: mssql.Time,
```

**Step 2: Commit**

```bash
git add src/server.js
git commit -m "feat: add deposit_time to admin request update"
```

---

### Task 5: Server.js — DOCX Generation

**Files:**
- Modify: `src/server.js:651-657`

**Step 1: Include deposit_time in DOCX table**

Change line 656 from:
```javascript
new TableCell({ children: [new Paragraph(new Date(data.deposit_date).toLocaleDateString('ko-KR'))] }),
```
to:
```javascript
new TableCell({ children: [new Paragraph(new Date(data.deposit_date).toLocaleDateString('ko-KR') + (data.deposit_time ? ' ' + data.deposit_time : ''))] }),
```

**Step 2: Commit**

```bash
git add src/server.js
git commit -m "feat: include deposit_time in DOCX generation"
```

---

### Task 6: index.html — Add Time Inputs to Both Forms

**Files:**
- Modify: `public/index.html:64-67,197-200`

**Step 1: Add time input to refund form (반환청구)**

After line 66 (the `deposit_date` input div, closing `</div>` at line 67), the deposit_date div currently spans one grid cell. Change it to include both date and time in the same cell.

Replace the deposit_date div (lines 64-67):
```html
                    <div class="lg:order-none order-[10]">
                        <label class="block text-sm font-bold text-gray-500 mb-1.5">입금 보낸 일자</label>
                        <input type="date" name="deposit_date" id="date_deposit" required class="w-full border border-gray-200 rounded-lg px-4 py-3.5 focus:ring-4 focus:ring-blue-50 focus:border-blue-500 outline-none font-bold text-base">
                    </div>
```
with:
```html
                    <div class="lg:order-none order-[10]">
                        <label class="block text-sm font-bold text-gray-500 mb-1.5">입금 보낸 일자</label>
                        <div class="flex gap-2">
                            <input type="date" name="deposit_date" id="date_deposit" required class="flex-1 min-w-0 border border-gray-200 rounded-lg px-4 py-3.5 focus:ring-4 focus:ring-blue-50 focus:border-blue-500 outline-none font-bold text-base">
                            <input type="time" name="deposit_time" id="time_deposit" step="1" required class="w-[130px] border border-gray-200 rounded-lg px-3 py-3.5 focus:ring-4 focus:ring-blue-50 focus:border-blue-500 outline-none font-bold text-base" placeholder="시:분:초">
                        </div>
                    </div>
```

**Step 2: Add time input to misdeposit form (오입금)**

Replace the misdeposit deposit_date div (lines 197-200):
```html
                    <div class="lg:order-none order-[10]">
                        <label class="block text-sm font-bold text-gray-500 mb-1.5">입금 보낸 일자</label>
                        <input type="date" name="deposit_date" id="md_date_deposit" required class="w-full border border-gray-200 rounded-lg px-4 py-3.5 focus:ring-4 focus:ring-orange-50 focus:border-orange-500 outline-none font-bold text-base">
                    </div>
```
with:
```html
                    <div class="lg:order-none order-[10]">
                        <label class="block text-sm font-bold text-gray-500 mb-1.5">입금 보낸 일자</label>
                        <div class="flex gap-2">
                            <input type="date" name="deposit_date" id="md_date_deposit" required class="flex-1 min-w-0 border border-gray-200 rounded-lg px-4 py-3.5 focus:ring-4 focus:ring-orange-50 focus:border-orange-500 outline-none font-bold text-base">
                            <input type="time" name="deposit_time" id="md_time_deposit" step="1" required class="w-[130px] border border-gray-200 rounded-lg px-3 py-3.5 focus:ring-4 focus:ring-orange-50 focus:border-orange-500 outline-none font-bold text-base" placeholder="시:분:초">
                        </div>
                    </div>
```

**Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: add deposit_time inputs to both public forms"
```

---

### Task 7: index.html — Change Header Title + Tab Styling

**Files:**
- Modify: `public/index.html:19,28-30`

**Step 1: Change header title**

At line 19, change:
```html
<a href="/public/index.html" class="text-lg sm:text-2xl font-bold text-gray-800 hover:text-blue-600 transition-colors no-underline whitespace-nowrap">신청 Form</a>
```
to:
```html
<a href="/public/index.html" class="text-lg sm:text-2xl font-bold text-gray-800 hover:text-blue-600 transition-colors no-underline whitespace-nowrap">오입금 신청</a>
```

**Step 2: Center and enlarge tabs**

At line 28, change:
```html
        <div class="flex border-b border-gray-200" id="formTabs">
```
to:
```html
        <div class="flex justify-center border-b border-gray-200" id="formTabs">
```

At line 29, change:
```html
            <button id="btnTabRefund" class="tab-btn tab-active px-5 py-3 text-sm font-black border-b-2 border-blue-600 text-blue-600 transition-all">반환 청구 사유서</button>
```
to:
```html
            <button id="btnTabRefund" class="tab-btn tab-active px-8 py-4 text-base font-black border-b-2 border-blue-600 text-blue-600 transition-all">반환 청구 사유서</button>
```

At line 30, change:
```html
            <button id="btnTabMisdeposit" class="tab-btn px-5 py-3 text-sm font-black border-b-2 border-transparent text-gray-400 hover:text-gray-600 transition-all">오입금 포인트 신청서</button>
```
to:
```html
            <button id="btnTabMisdeposit" class="tab-btn px-8 py-4 text-base font-black border-b-2 border-transparent text-gray-400 hover:text-gray-600 transition-all">오입금 포인트 신청서</button>
```

**Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: change header to 오입금 신청, enlarge and center tabs"
```

---

### Task 8: admin.js — DataTables Column + Detail Modal

**Files:**
- Modify: `public/js/admin.js:198,450-454,474-477,1027`

**Step 1: Add deposit_time to DataTables row**

At line 198, change:
```javascript
                fmtDate(i.deposit_date),
```
to:
```javascript
                fmtDate(i.deposit_date) + (i.deposit_time ? ' ' + i.deposit_time : ''),
```

**Step 2: Add deposit_time to detail modal (desktop table)**

At lines 452-453, change:
```html
                <th class="bg-[#F5F5F5] border border-[#D4D4D4] px-3 py-2.5 text-left text-[#404040] font-bold text-sm">입금일</th>
                <td class="border border-[#D4D4D4] px-3 py-2.5 text-[#1A1A1A] text-sm">${fmtDate(d.deposit_date)}</td>
```
to:
```html
                <th class="bg-[#F5F5F5] border border-[#D4D4D4] px-3 py-2.5 text-left text-[#404040] font-bold text-sm">입금일시</th>
                <td class="border border-[#D4D4D4] px-3 py-2.5 text-[#1A1A1A] text-sm">${fmtDate(d.deposit_date)}${d.deposit_time ? ' ' + d.deposit_time : ''}</td>
```

**Step 3: Add deposit_time to detail modal (mobile card)**

At line 476, change:
```html
                <div class="px-3 py-2 border-b border-[#D4D4D4]"><span class="text-xs font-bold text-[#404040]">입금일</span><p class="text-sm text-[#1A1A1A] mt-0.5">${fmtDate(d.deposit_date)}</p></div>
```
to:
```html
                <div class="px-3 py-2 border-b border-[#D4D4D4]"><span class="text-xs font-bold text-[#404040]">입금일시</span><p class="text-sm text-[#1A1A1A] mt-0.5">${fmtDate(d.deposit_date)}${d.deposit_time ? ' ' + d.deposit_time : ''}</p></div>
```

**Step 4: Add deposit_time to Excel export**

At line 1027, change:
```javascript
                '입금일': fmtDate(item.deposit_date),
```
to:
```javascript
                '입금일': fmtDate(item.deposit_date),
                '입금시간': item.deposit_time || '',
```

**Step 5: Commit**

```bash
git add public/js/admin.js
git commit -m "feat: add deposit_time to DataTables, detail modal, and Excel export"
```

---

### Task 9: admin.js — Create Modal

**Files:**
- Modify: `public/js/admin.js:541,581,606`

**Step 1: Add time input field to create modal**

After line 541 (`입금일` input div), add a new div:
```javascript
            <div><label class="text-xs font-bold text-[#404040] mb-0.5 block">입금시간 <span class="text-red-500">*</span></label><input id="create_deposit_time" type="time" step="1" class="${inputClass}"></div>
```

**Step 2: Add to client-side validation**

At line 581, after `'#create_deposit_date': '입금일자',` add:
```javascript
        '#create_deposit_time': '입금시간',
```

**Step 3: Add to FormData**

After line 606 (`fd.append('deposit_date', ...)`), add:
```javascript
    fd.append('deposit_time', $('#create_deposit_time').val());
```

**Step 4: Commit**

```bash
git add public/js/admin.js
git commit -m "feat: add deposit_time to admin create modal"
```

---

### Task 10: admin.js — Edit Modal

**Files:**
- Modify: `public/js/admin.js:852,885,910`

**Step 1: Add time input field to edit modal**

After line 852 (`입금일` input div), add a new div:
```javascript
            <div><label class="text-xs font-bold text-[#404040] mb-1 block">입금시간</label><input id="edit_deposit_time" type="time" step="1" class="${inputClass}" value="${d.deposit_time || ''}"></div>
```

**Step 2: Add to client-side validation**

At line 885, after `'#edit_deposit_date': '입금일자',` add:
```javascript
        '#edit_deposit_time': '입금시간',
```

**Step 3: Add to FormData**

After line 910 (`fd.append('deposit_date', ...)`), add:
```javascript
    fd.append('deposit_time', $('#edit_deposit_time').val());
```

**Step 4: Commit**

```bash
git add public/js/admin.js
git commit -m "feat: add deposit_time to admin edit modal"
```

---

### Task 11: Update CLAUDE.md Schema Documentation

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update schema description**

In the `Requests` table description in CLAUDE.md, add `deposit_time TIME NULL` after `deposit_date`.

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add deposit_time to schema documentation"
```

---

## Summary of All Changes

| File | Changes |
|------|---------|
| `src/schema.sql` | Migration: `ALTER TABLE Requests ADD deposit_time TIME NULL` |
| `src/server.js` | FIELD_LABELS, required arrays, INSERT params (×2), allowedFields, DOCX |
| `public/index.html` | Time inputs in both forms, header title, tab styling |
| `public/js/admin.js` | DataTables row, detail modal (desktop+mobile), create modal, edit modal, Excel export |
| `CLAUDE.md` | Schema docs |
