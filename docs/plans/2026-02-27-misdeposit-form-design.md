# 오입금 포인트 신청서 추가 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an "오입금 포인트 신청서" tab to the public form alongside the existing "반환 청구 사유서", with a `request_type` column in the DB and a type column+filter in the admin dashboard.

**Architecture:** Single `request_type` column (`'반환청구'` | `'오입금'`) added to the existing `Requests` table. Public page gets tab UI switching between two forms. Server validates differently per type. Admin table gets a type column and filter.

**Tech Stack:** MSSQL (schema migration), Express.js (server.js validation), Vanilla HTML/JS (index.html, index.js, admin.html, admin.js), Tailwind CSS

---

### Task 1: Database — Add `request_type` column

**Files:**

- Modify: `src/schema.sql` (append migration after line 117, add MS_Description after line 287)

**Step 1: Add migration SQL to `schema.sql`**

After the existing migration block `-- 4-3. RequestFiles category` (line 115-117), add:

```sql
-- 4-5. request_type 컬럼 추가 (반환청구 / 오입금 구분)
IF COL_LENGTH('Requests', 'request_type') IS NULL
BEGIN
    ALTER TABLE Requests ADD request_type NVARCHAR(10) NOT NULL
        CONSTRAINT DF_Requests_request_type DEFAULT N'반환청구';
    ALTER TABLE Requests ADD CONSTRAINT CK_Requests_request_type
        CHECK (request_type IN (N'반환청구', N'오입금'));
END
```

Also add MS_Description at the end of schema.sql (after the last `EXEC sp_addextendedproperty` for RequestFiles):

```sql
-- ─── Requests.request_type ───
BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'request_type'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'신청 유형 (반환청구 또는 오입금). CHECK 제약으로 2개 값만 허용.', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'request_type';
```

**Step 2: Run migration**

Run: `node src/dbPush.js`
Expected: "Schema pushed successfully" (or similar success message)

**Step 3: Commit**

```bash
git add src/schema.sql
git commit -m "feat: add request_type column to Requests table (반환청구/오입금)"
```

---

### Task 2: Server — Update `POST /api/request` for type-aware validation

**Files:**

- Modify: `src/server.js:414-506` (public submit route)

**Step 1: Update multer fields to accept optional id_card_files**

At line 415, change the `upload.fields` to increase `id_card_files` maxCount to 5 (to match admin route) — the validation below handles whether it's required:

```js
app.post('/api/request', submitLimiter, upload.fields([{ name: 'deposit_files', maxCount: 5 }, { name: 'id_card_files', maxCount: 5 }]), fixUploadedFileNames, validateFileMagic, async (req, res) => {
```

**Step 2: Add `request_type` validation and conditional logic**

After the `const d = req.body;` line (418), add request_type validation:

```js
const requestType = d.request_type || "반환청구";
if (!["반환청구", "오입금"].includes(requestType)) {
  cleanupUpload(req);
  return res
    .status(400)
    .json({ success: false, error: "유효하지 않은 신청 유형입니다." });
}
```

**Step 3: Add amount validation for 반환청구**

After the existing phone validation (line 428), add:

```js
if (requestType === "반환청구") {
  const amountNum = Number(d.deposit_amount.replace(/\D/g, ""));
  if (amountNum < 2000000) {
    cleanupUpload(req);
    return res.status(400).json({
      success: false,
      error: "반환 청구는 200만원 이상만 신청 가능합니다.",
    });
  }
}
```

**Step 4: Make file validation conditional on type**

Replace the existing file validation (lines 430-433):

```js
const depositFiles = (req.files && req.files.deposit_files) || [];
const idCardFiles = (req.files && req.files.id_card_files) || [];
if (depositFiles.length === 0) {
  cleanupUpload(req);
  return res.status(400).json({
    success: false,
    error: "입출금내역서 파일은 최소 1개 필수입니다.",
  });
}
if (requestType === "반환청구" && idCardFiles.length === 0) {
  cleanupUpload(req);
  return res
    .status(400)
    .json({ success: false, error: "신분증 파일은 최소 1개 필수입니다." });
}
```

Note: The only change is adding `requestType === '반환청구' &&` before the id card check.

**Step 5: Add `request_type` to INSERT query**

In the transaction insert (lines 444-461), add the request_type input and column:

Add after `.input('termsIp', ...)`:

```js
                .input('requestType', mssql.NVarChar, requestType)
```

Change the INSERT SQL to include `request_type`:

```sql
INSERT INTO Requests (request_code, request_date, deposit_date, deposit_amount, bank_name, user_account, user_account_name, contractor_code, merchant_code, applicant_name, applicant_phone, details, id_card_file, terms_agreed, terms_ip, request_type)
OUTPUT INSERTED.id
VALUES (@requestCode, CAST(GETDATE() AS DATE), @depositDate, @depositAmount, @bankName, @userAccount, @userAccountName, @contractorCode, @merchantCode, @applicantName, @applicantPhone, @details, @idCardFile, @termsAgreed, @termsIp, @requestType)
```

**Step 6: Update Telegram notification to include type**

At line 492-494, change the notification message:

```js
const typeLabel = requestType === "오입금" ? "오입금 포인트" : "반환 청구";
sendTelegramNotification(
  `<b>새 ${typeLabel} 접수</b>\n식별코드: <code>${requestCode}</code>\n신청인: ${maskedName}\n파일: ${allFiles.length}개\n접수시간: ${kstTime}`,
).catch(() => {});
```

**Step 7: Commit**

```bash
git add src/server.js
git commit -m "feat: add request_type support to public submit API with conditional validation"
```

---

### Task 3: Server — Update admin `POST /api/admin/request` for type support

**Files:**

- Modify: `src/server.js:734-813` (admin create route)

**Step 1: Add request_type to admin create route**

After `const d = req.body;` at line 736, add:

```js
const requestType = d.request_type || "반환청구";
if (!["반환청구", "오입금"].includes(requestType)) {
  cleanupUpload(req);
  return res
    .status(400)
    .json({ success: false, error: "유효하지 않은 신청 유형입니다." });
}
```

**Step 2: Add `request_type` to admin INSERT query**

In the admin insert (lines 760-778), add:

After `.input('termsIp', ...)`:

```js
                .input('requestType', mssql.NVarChar, requestType)
```

Change the INSERT SQL columns to include `request_type`:

```sql
INSERT INTO Requests (request_code, request_date, deposit_date, deposit_amount, bank_name, user_account, user_account_name, contractor_code, merchant_code, applicant_name, applicant_phone, details, id_card_file, terms_agreed, terms_ip, request_type)
OUTPUT INSERTED.id
VALUES (@requestCode, @requestDate, @depositDate, @depositAmount, @bankName, @userAccount, @userAccountName, @contractorCode, @merchantCode, @applicantName, @applicantPhone, @details, @idCardFile, @termsAgreed, @termsIp, @requestType)
```

**Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat: add request_type support to admin create API"
```

---

### Task 4: Frontend — Add tab UI to `index.html`

**Files:**

- Modify: `public/index.html`

**Step 1: Update nav title**

At line 17, change the nav link text from `반환 청구 사유서 Form` to `사유서 Form` (generic since it now covers both types):

```html
<a
  href="/public/index.html"
  class="text-lg sm:text-2xl font-bold text-gray-800 hover:text-blue-600 transition-colors no-underline whitespace-nowrap"
  >사유서 Form</a
>
```

**Step 2: Add tab bar below nav, above main**

Insert between the `</nav>` (line 23) and `<main>` (line 25):

```html
<div class="max-w-6xl mx-auto px-4 pt-6 sm:pt-8">
  <div class="flex border-b border-gray-200" id="formTabs">
    <button
      onclick="showRefundTab()"
      id="tabRefund"
      class="tab-btn tab-active px-5 py-3 text-sm font-black border-b-2 border-blue-600 text-blue-600 transition-all"
    >
      반환 청구 사유서
    </button>
    <button
      onclick="showMisdepositTab()"
      id="tabMisdeposit"
      class="tab-btn px-5 py-3 text-sm font-black border-b-2 border-transparent text-gray-400 hover:text-gray-600 transition-all"
    >
      오입금 포인트 신청서
    </button>
  </div>
</div>
```

**Step 3: Wrap existing form in a refund container**

Wrap the existing `<div id="submitSection">` content: add `id="refundForm"` to the existing `submitSection` div. The existing form stays as-is.

Add a hidden input inside the existing `<form id="requestForm">` (right after the opening `<form>` tag at line 29):

```html
<input type="hidden" name="request_type" value="반환청구" />
```

**Step 4: Add the misdeposit form section**

After the closing `</div>` of `id="submitSection"` (line 158) and before `<div id="statusSection">` (line 161), add the misdeposit form. It mirrors the refund form but:

- Different ID: `id="misdepositSection"` with `class="hidden"`
- Hidden input: `request_type=오입금`
- Warning banner: 오입금 관련 안내
- No 신분증 file upload section
- No minimum amount validation text
- Uses separate form ID: `id="misdepositForm"`
- File inputs use different IDs: `md-deposit-file-upload`, `md-deposit-drop-zone`, etc.

```html
<div
  id="misdepositSection"
  class="hidden bg-white rounded-lg shadow-sm p-5 sm:p-8 border border-gray-200"
>
  <form id="misdepositForm">
    <input type="hidden" name="request_type" value="오입금" />
    <!-- 경고배너 -->
    <div
      class="bg-orange-50 border border-orange-200 rounded-lg px-4 py-3 mb-6 text-center"
    >
      <p class="text-orange-800 font-bold text-sm">
        오입금 확인 후 포인트로 전환 처리됩니다. 정확한 입금 내역을 첨부해
        주세요.
      </p>
    </div>

    <div
      class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-x-8"
    >
      <h3
        class="text-lg font-black text-orange-600 mb-0 tracking-widest flex items-center gap-2 md:col-span-2 lg:order-none order-1"
      >
        <span class="w-1 h-4 bg-orange-600 rounded-full"></span> 업체·신청인
        정보
      </h3>
      <h3
        class="text-lg font-black text-orange-600 mb-0 tracking-widest flex items-center gap-2 md:col-span-2 lg:order-none order-[9]"
      >
        <span class="w-1 h-4 bg-orange-600 rounded-full"></span> 입금 정보
      </h3>

      <!-- Row 1: 지사코드 / 가맹점코드 / 입금일자 / 입금액 -->
      <div class="lg:order-none order-2">
        <label class="block text-sm font-bold text-gray-500 mb-1.5"
          >지사코드 (구분코드1)</label
        >
        <input
          type="text"
          name="contractor_type"
          maxlength="30"
          placeholder="한글, 영어, 숫자 (최대 30자)"
          required
          class="form-input-custom w-full border border-gray-200 rounded-lg px-4 py-3.5 focus:ring-4 focus:ring-orange-50 focus:border-orange-500 outline-none font-bold text-base"
        />
      </div>
      <div class="lg:order-none order-3">
        <label class="block text-sm font-bold text-gray-500 mb-1.5"
          >가맹점코드 (구분코드2)</label
        >
        <input
          type="text"
          name="merchant_type"
          maxlength="30"
          placeholder="한글, 영어, 숫자 (최대 30자)"
          required
          class="form-input-custom w-full border border-gray-200 rounded-lg px-4 py-3.5 focus:ring-4 focus:ring-orange-50 focus:border-orange-500 outline-none font-bold text-base"
        />
      </div>
      <div class="lg:order-none order-[10]">
        <label class="block text-sm font-bold text-gray-500 mb-1.5"
          >입금 보낸 일자</label
        >
        <input
          type="date"
          name="deposit_date"
          id="md_date_deposit"
          required
          class="w-full border border-gray-200 rounded-lg px-4 py-3.5 focus:ring-4 focus:ring-orange-50 focus:border-orange-500 outline-none font-bold text-base"
        />
      </div>
      <div class="lg:order-none order-[11]">
        <label class="block text-sm font-bold text-gray-500 mb-1.5"
          >입금액 (원)</label
        >
        <input
          type="text"
          name="deposit_amount"
          id="md_input_amount"
          placeholder="숫자만 입력"
          required
          class="w-full border border-gray-200 rounded-lg px-4 py-3.5 focus:ring-4 focus:ring-orange-50 focus:border-orange-500 outline-none transition-all font-black text-base text-orange-600"
        />
      </div>

      <!-- Row 2: 신청인이름 / 전화번호 / 상세사유 -->
      <div class="lg:order-none order-4">
        <label class="block text-sm font-bold text-gray-500 mb-1.5"
          >신청인 이름 (계좌주)</label
        >
        <input
          type="text"
          name="applicant_name"
          maxlength="20"
          placeholder="예: 홍길동 (최대 20자)"
          required
          class="form-input-custom w-full border border-gray-200 rounded-lg px-4 py-3.5 focus:ring-4 focus:ring-orange-50 focus:border-orange-500 outline-none transition-all font-bold text-base"
        />
      </div>
      <div class="lg:order-none order-5">
        <label class="block text-sm font-bold text-gray-500 mb-1.5"
          >신청인 전화번호</label
        >
        <input
          type="tel"
          name="applicant_phone"
          id="md_input_phone"
          maxlength="13"
          placeholder="숫자만"
          required
          class="w-full border border-gray-200 rounded-lg px-4 py-3.5 focus:ring-4 focus:ring-orange-50 focus:border-orange-500 outline-none transition-all font-bold text-base"
        />
      </div>
      <div
        class="md:col-span-2 lg:row-span-2 lg:order-none order-[12] flex flex-col"
      >
        <div class="flex justify-between items-baseline mb-1.5">
          <label class="block text-sm font-bold text-gray-500"
            >상세 사유 (최대 200자)</label
          >
          <span
            id="md-char-count"
            class="text-xs font-bold text-gray-400 tracking-tighter"
            >0 / 200</span
          >
        </div>
        <textarea
          id="md_input_details"
          name="details"
          maxlength="200"
          rows="3"
          class="w-full flex-1 border border-gray-200 rounded-lg px-4 py-4 focus:ring-4 focus:ring-orange-50 focus:border-orange-500 outline-none transition-all resize-none font-medium text-gray-600 text-base"
          placeholder="오입금 포인트 전환 사유를 상세히 적어주세요."
        ></textarea>
      </div>

      <!-- Row 3: 은행명 / 계좌번호 -->
      <div class="lg:order-none order-6">
        <label class="block text-sm font-bold text-gray-500 mb-1.5"
          >은행명</label
        >
        <input
          type="text"
          name="bank_name"
          maxlength="20"
          placeholder="예: 신한은행"
          required
          class="form-input-custom w-full border border-gray-200 rounded-lg px-4 py-3.5 focus:ring-4 focus:ring-orange-50 focus:border-orange-500 outline-none font-bold text-base"
        />
      </div>
      <div class="lg:order-none order-7">
        <label class="block text-sm font-bold text-gray-500 mb-1.5"
          >출금 나간 계좌번호</label
        >
        <input
          type="text"
          name="refund_account"
          id="md_input_account"
          maxlength="16"
          placeholder="- 없이 숫자만 입력 (최대 16자)"
          required
          class="w-full border border-gray-200 rounded-lg px-4 py-3.5 focus:ring-4 focus:ring-orange-50 focus:border-orange-500 outline-none transition-all font-black text-base tracking-tighter"
        />
      </div>

      <!-- 입금내역서 업로드 (신분증 없음) -->
      <div class="md:col-span-2 lg:col-span-4 lg:order-none order-[13]">
        <h4
          class="text-sm font-black text-orange-500 mb-3 tracking-widest flex items-center gap-2"
        >
          <span class="w-1 h-3 bg-orange-500 rounded-full"></span> 입금내역서
        </h4>

        <input
          id="md-deposit-file-upload"
          type="file"
          class="hidden"
          accept=".png,.jpg,.jpeg,.pdf"
          multiple
        />

        <div
          id="md-deposit-drop-zone"
          class="mt-1 flex flex-col justify-center items-center px-6 py-8 border-2 border-gray-200 border-dashed rounded-lg hover:bg-orange-50 hover:border-orange-400 transition-all cursor-pointer group"
        >
          <svg
            class="h-10 w-10 text-gray-300 group-hover:text-orange-500 transition-colors mb-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            ></path>
          </svg>
          <p class="text-gray-700 font-bold text-sm">
            입금내역서 파일을 이 곳에 끌어다 놓으세요
          </p>
          <p class="text-xs text-gray-400 mt-1">
            최대 5개, 10MB/개, PNG/JPG/PDF
          </p>
        </div>

        <div id="mdDepositFilePreview" class="hidden mt-3">
          <div
            class="flex flex-col gap-3 p-4 bg-orange-50 border border-orange-100 rounded-lg"
          >
            <div class="flex items-center justify-between">
              <p class="text-xs font-black text-orange-400 tracking-widest">
                입금내역서 (<span id="mdDepositFileCount">0</span>/5)
              </p>
              <button
                type="button"
                onclick="clearAllMdDepositFiles()"
                class="text-xs font-bold text-red-400 hover:text-red-600 transition-colors"
              >
                전체 삭제
              </button>
            </div>
            <div id="mdDepositFileList" class="space-y-2"></div>
            <button
              type="button"
              onclick="document.getElementById('md-deposit-file-upload').click()"
              class="text-xs font-bold text-orange-500 hover:text-orange-700 transition-colors mt-1"
              id="mdDepositAddMoreBtn"
            >
              + 파일 추가
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 약관 동의 + 제출 버튼 -->
    <div class="mt-8 space-y-5">
      <div
        class="flex items-center justify-center bg-gray-50 px-4 py-3.5 rounded-lg border border-gray-200"
      >
        <input
          id="md_terms"
          name="terms"
          type="checkbox"
          required
          class="w-5 h-5 text-orange-600 border-gray-300 rounded focus:ring-orange-500 cursor-pointer flex-shrink-0"
        />
        <div
          class="ml-3 text-sm sm:text-base font-bold text-gray-700 cursor-pointer underline decoration-orange-200 underline-offset-4"
          onclick="document.getElementById('md_terms').click()"
        >
          개인정보 수집 및 이용 동의 (필수)
          <button
            type="button"
            onclick="event.stopPropagation(); openTermsModal()"
            class="text-xs font-black bg-orange-600 text-white px-2.5 py-0.5 rounded ml-2 shadow-sm tracking-tighter"
          >
            보기
          </button>
        </div>
      </div>

      <button
        type="submit"
        class="w-full bg-orange-600 text-white font-black py-3.5 rounded-lg hover:bg-orange-700 transition-all shadow-sm active:scale-[0.98] text-lg"
      >
        오입금 포인트 신청하기
      </button>
    </div>
  </form>
</div>
```

**Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: add tab UI and misdeposit form to index.html"
```

---

### Task 5: Frontend — Add tab switching and misdeposit form logic to `index.js`

**Files:**

- Modify: `public/js/index.js`

**Step 1: Add tab switching functions**

At the top of `index.js` (after the `isSubmitting` variable at line 34), add:

```js
// ── 탭 전환 ──
function showRefundTab() {
  document.getElementById("submitSection").classList.remove("hidden");
  document.getElementById("misdepositSection").classList.add("hidden");
  document.getElementById("statusSection").classList.add("hidden");
  document
    .getElementById("tabRefund")
    .classList.add("tab-active", "border-blue-600", "text-blue-600");
  document
    .getElementById("tabRefund")
    .classList.remove("border-transparent", "text-gray-400");
  document
    .getElementById("tabMisdeposit")
    .classList.remove("tab-active", "border-orange-600", "text-orange-600");
  document
    .getElementById("tabMisdeposit")
    .classList.add("border-transparent", "text-gray-400");
  window.scrollTo(0, 0);
}
function showMisdepositTab() {
  document.getElementById("submitSection").classList.add("hidden");
  document.getElementById("misdepositSection").classList.remove("hidden");
  document.getElementById("statusSection").classList.add("hidden");
  document
    .getElementById("tabMisdeposit")
    .classList.add("tab-active", "border-orange-600", "text-orange-600");
  document
    .getElementById("tabMisdeposit")
    .classList.remove("border-transparent", "text-gray-400");
  document
    .getElementById("tabRefund")
    .classList.remove("tab-active", "border-blue-600", "text-blue-600");
  document
    .getElementById("tabRefund")
    .classList.add("border-transparent", "text-gray-400");
  window.scrollTo(0, 0);
}
window.showRefundTab = showRefundTab;
window.showMisdepositTab = showMisdepositTab;
```

**Step 2: Add misdeposit file management**

After the existing 신분증 file management section (after line 174), add:

```js
// ── 오입금 입금내역서 파일 관리 ──
const mdDepositDropZone = document.getElementById("md-deposit-drop-zone");
const mdDepositFileInput = document.getElementById("md-deposit-file-upload");
const mdDepositFilePreview = document.getElementById("mdDepositFilePreview");
const mdDepositFileListEl = document.getElementById("mdDepositFileList");
const mdDepositFileCountEl = document.getElementById("mdDepositFileCount");
let selectedMdDepositFiles = [];

if (mdDepositDropZone && mdDepositFileInput) {
  setupDropZone(
    mdDepositDropZone,
    mdDepositFileInput,
    selectedMdDepositFiles,
    5,
    (files) => {
      handleFilesGeneric(
        files,
        selectedMdDepositFiles,
        mdDepositFileInput,
        5,
        "입금내역서",
      );
      renderMdDepositFileList();
    },
  );
}
function renderMdDepositFileList() {
  renderFileListGeneric(
    selectedMdDepositFiles,
    mdDepositDropZone,
    mdDepositFilePreview,
    mdDepositFileListEl,
    mdDepositFileCountEl,
    "mdDepositAddMoreBtn",
    "removeMdDepositFile",
    "border-orange-100",
  );
}
function removeMdDepositFile(idx) {
  selectedMdDepositFiles.splice(idx, 1);
  renderMdDepositFileList();
}
function clearAllMdDepositFiles() {
  selectedMdDepositFiles = [];
  mdDepositFileInput.value = "";
  renderMdDepositFileList();
}
window.clearAllMdDepositFiles = clearAllMdDepositFiles;
window.removeMdDepositFile = removeMdDepositFile;
window.renderMdDepositFileList = renderMdDepositFileList;
```

**Step 3: Add misdeposit date/phone/amount input handlers**

After the existing input handlers section (after line 227), add handlers for the misdeposit form inputs. These mirror the refund form handlers but target `md_` prefixed IDs:

```js
// ── 오입금 폼 입력 핸들러 ──
const mdDateDepositEl = document.getElementById("md_date_deposit");
if (mdDateDepositEl) {
  mdDateDepositEl.max = todayKST;
  mdDateDepositEl.value = todayKST;
}

const mdInputPhoneEl = document.getElementById("md_input_phone");
if (mdInputPhoneEl) {
  mdInputPhoneEl.addEventListener("input", (e) => {
    let v = e.target.value.replace(/\D/g, "").slice(0, 11);
    if (v.length > 3 && v.length <= 7) v = v.slice(0, 3) + "-" + v.slice(3);
    else if (v.length > 7)
      v = v.slice(0, 3) + "-" + v.slice(3, 7) + "-" + v.slice(7);
    e.target.value = v;
  });
}

const mdInputAmountEl = document.getElementById("md_input_amount");
if (mdInputAmountEl) {
  mdInputAmountEl.addEventListener("input", (e) => {
    let v = e.target.value.replace(/\D/g, "");
    if (v.length > 10) v = v.slice(0, 10);
    if (parseInt(v) > 9999999999) v = "9999999999";
    e.target.value = v.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  });
}

const mdInputAccountEl = document.getElementById("md_input_account");
if (mdInputAccountEl) {
  mdInputAccountEl.addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 16);
  });
}

const mdDetailsInput = document.getElementById("md_input_details");
const mdCharCount = document.getElementById("md-char-count");
if (mdDetailsInput && mdCharCount) {
  let mdDetailsComposing = false;
  mdDetailsInput.addEventListener("compositionstart", () => {
    mdDetailsComposing = true;
  });
  mdDetailsInput.addEventListener("compositionend", () => {
    mdDetailsComposing = false;
    mdDetailsInput.value = stripSymbolsText(mdDetailsInput.value);
    mdCharCount.textContent = `${mdDetailsInput.value.length} / 200`;
    if (mdDetailsInput.value.length >= 200)
      mdCharCount.classList.add("text-red-500");
    else mdCharCount.classList.remove("text-red-500");
  });
  mdDetailsInput.addEventListener("input", () => {
    if (mdDetailsComposing) return;
    mdDetailsInput.value = stripSymbolsText(mdDetailsInput.value);
    mdCharCount.textContent = `${mdDetailsInput.value.length} / 200`;
    if (mdDetailsInput.value.length >= 200)
      mdCharCount.classList.add("text-red-500");
    else mdCharCount.classList.remove("text-red-500");
  });
}
```

**Step 4: Add 200만원 validation to existing refund form submit**

In the existing form submit handler (line 276-320), after the existing errors checks (before `if (errors.length > 0)`), add:

```js
const amountRaw = Number(formData.get("deposit_amount").replace(/,/g, ""));
if (amountRaw < 2000000)
  errors.push("반환 청구는 200만원 이상만 신청 가능합니다");
```

**Step 5: Add misdeposit form submit handler**

After the existing form submit handler (after line 320), add:

```js
const mdForm = document.getElementById("misdepositForm");
if (mdForm) {
  const mdSubmitBtn = mdForm.querySelector('button[type="submit"]');
  const mdSubmitBtnOrigText = mdSubmitBtn.textContent;
  mdForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    const formData = new FormData(mdForm);
    const errors = [];
    if (!formData.get("applicant_name").trim()) errors.push("이름 필수");
    if (formData.get("applicant_phone").replace(/\D/g, "").length < 10)
      errors.push("연락처 확인");
    if (!formData.get("deposit_amount")) errors.push("금액 필수");
    if (selectedMdDepositFiles.length === 0)
      errors.push("입금내역서 파일 필수");
    if (!formData.get("terms")) errors.push("약관 동의 필수");

    if (errors.length > 0) {
      Swal.fire({
        icon: "warning",
        title: "입력 누락",
        html: errors.join("<br>"),
      });
      return;
    }

    isSubmitting = true;
    mdSubmitBtn.disabled = true;
    mdSubmitBtn.textContent = "제출 중...";

    formData.set(
      "deposit_amount",
      formData.get("deposit_amount").replace(/,/g, ""),
    );
    formData.set("terms_agreed", formData.get("terms") ? "1" : "0");
    selectedMdDepositFiles.forEach((f) =>
      formData.append("deposit_files", f, f.name),
    );

    try {
      const { ok, data: res } = await safeFetch(
        "/api/request",
        { method: "POST", body: formData },
        60000,
      );
      if (ok && res.success) {
        downloadCodeAsTxt(res.requestCode);
        const code = String(res.requestCode).replace(
          /[&<>"']/g,
          (c) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[c],
        );
        let copied = false;
        try {
          const ta = document.createElement("textarea");
          ta.value = res.requestCode;
          ta.style.cssText = "position:fixed;opacity:0";
          document.body.appendChild(ta);
          ta.select();
          copied = document.execCommand("copy");
          document.body.removeChild(ta);
        } catch (e) {}
        Swal.fire({
          icon: "success",
          title: "제출 완료",
          html: `<p class="text-sm text-gray-500 mt-2">식별코드: <strong class="text-orange-600 text-xl">${code}</strong></p><p class="text-xs text-gray-400 mt-1">${copied ? "클립보드에 복사되었습니다" : "식별코드를 메모해 주세요"}</p><p class="text-xs text-green-600 mt-1">식별코드 파일이 다운로드되었습니다</p>`,
        }).then(() => location.reload());
      } else {
        Swal.fire("오류", res.error || "제출에 실패했습니다.", "error");
      }
    } catch (err) {
      console.error("Submit error:", err);
      Swal.fire("오류", err.message, "error");
    } finally {
      isSubmitting = false;
      mdSubmitBtn.disabled = false;
      mdSubmitBtn.textContent = mdSubmitBtnOrigText;
    }
  });
}
```

**Step 6: Update `showStatusCheck()` and `showSubmit()` to handle tabs**

Replace the existing `showStatusCheck` and `showSubmit` functions (line 348-349):

```js
function showStatusCheck() {
  document.getElementById("submitSection").classList.add("hidden");
  document.getElementById("misdepositSection").classList.add("hidden");
  document.getElementById("statusSection").classList.remove("hidden");
  document.getElementById("formTabs").classList.add("hidden");
  window.scrollTo(0, 0);
}
function showSubmit() {
  document.getElementById("statusSection").classList.add("hidden");
  document.getElementById("formTabs").classList.remove("hidden");
  // Restore whichever tab was active
  if (
    document.getElementById("tabMisdeposit").classList.contains("tab-active")
  ) {
    showMisdepositTab();
  } else {
    showRefundTab();
  }
}
```

**Step 7: Commit**

```bash
git add public/js/index.js
git commit -m "feat: add misdeposit tab switching, file management, and form submission to index.js"
```

---

### Task 6: Admin — Add type column and filter to `admin.html`

**Files:**

- Modify: `public/admin.html:82-112`

**Step 1: Add type filter dropdown**

After the `filter_status` select (line 89), before the reset button (line 90), add:

```html
<select
  id="filter_type"
  class="bg-[#FAFAFA] border border-[#E5E5E5] rounded-md px-3 py-2 text-sm font-semibold text-[#404040] outline-none focus:border-[#A3A3A3] cursor-pointer"
>
  <option value="">유형: 전체</option>
  <option value="반환청구">반환청구</option>
  <option value="오입금">오입금</option>
</select>
```

**Step 2: Add type column header to table**

After `<th>식별코드</th>` (line 102), add:

```html
<th>유형</th>
```

**Step 3: Commit**

```bash
git add public/admin.html
git commit -m "feat: add type filter and column header to admin table"
```

---

### Task 7: Admin — Update `admin.js` for type column, filter, and detail display

**Files:**

- Modify: `public/js/admin.js`

**Step 1: Update DataTable columnDefs for new column**

At line 74-77, the existing columnDefs reference column indices. With the new "유형" column inserted at index 3 (after 식별코드 at index 2), all indices from 3 onward shift by 1. Update:

```js
        columnDefs: [
            { orderable: false, className: 'select-checkbox', targets: 0 },
            { orderable: false, targets: [4, 5, 6, 7, 10, 11, 12] },
            { className: 'dt-center', targets: '_all' }
        ],
```

**Step 2: Update row data-id reference**

At line 127, the `data[11]` references the "상세" column. With the new column, this becomes `data[12]`:

```js
const id = $(data[12]).data("id");
```

At line 237, same change:

```js
const id = $(rowData[12]).data("id");
```

**Step 3: Update `loadData()` to include type badge in table rows**

In the `loadData()` function (line 155-183), in the `table.row.add([...])` call, add the type badge after the request code (after `r[2]`). The new column array becomes:

```js
table.row.add([
  "",
  fmtDate(i.request_date),
  `<span class="font-mono font-bold text-[#1A1A1A]">${esc(i.request_code)}</span>`,
  i.request_type === "오입금"
    ? '<span class="inline-block px-2 py-0.5 rounded text-xs font-black bg-orange-100 text-orange-700">오입금</span>'
    : '<span class="inline-block px-2 py-0.5 rounded text-xs font-black bg-blue-100 text-blue-700">반환청구</span>',
  esc(i.contractor_code) || "-",
  esc(i.merchant_code) || "-",
  `<span class="font-semibold text-[#1A1A1A]">${esc(i.applicant_name)}</span>`,
  `<span class="font-mono text-[14px] text-[#737373]">${fmtPhone(i.applicant_phone)}</span>`,
  fmtDate(i.deposit_date),
  `<span class="font-bold text-[#1A1A1A]">${Number(i.deposit_amount).toLocaleString()}</span>`,
  `<span class="text-[14px] text-[#737373]">${accountInfo}</span>`,
  statusDd,
  `<span class="text-[13px] text-[#A3A3A3] underline underline-offset-2 cursor-pointer hover:text-[#1A1A1A]" data-id="${i.id}">보기</span>`,
]);
```

**Step 4: Add type filter to the custom search function**

In the filter cache variables (line 230), add:

```js
let cachedFC = "",
  cachedFM = "",
  cachedFS = "",
  cachedFT = "",
  cachedQ = "";
```

In `syncFilterCache()` (line 272-277), add:

```js
cachedFT = $("#filter_type").val() || "";
```

In the `$.fn.dataTable.ext.search.push` function (line 232-269), after the status filter check (line 248), add:

```js
// 필터: 유형
if (cachedFT && item.request_type !== cachedFT) return false;
```

**Step 5: Register filter change handler for type**

At line 280, update the selector to include `#filter_type`:

```js
$('#filter_contractor, #filter_merchant, #filter_status, #filter_type').on('change', function() {
```

**Step 6: Add `request_type` to search fields**

In the search fields array (line 252-264), add `item.request_type`:

```js
const searchFields = [
  item.request_code,
  item.applicant_name,
  item.applicant_phone,
  item.contractor_code,
  item.merchant_code,
  item.bank_name,
  item.user_account,
  item.user_account_name,
  item.status,
  item.details,
  item.request_type,
  String(item.deposit_amount),
].map((v) => (v || "").toLowerCase());
```

**Step 7: Update Excel export to include type**

In the `exportToExcel()` function (line 973-991), add type to the data object. Insert after `'식별코드': code,`:

```js
                '유형': item.request_type || '반환청구',
```

**Step 8: Update `openDetail()` to show type**

In `openDetail()` (line 307+), in the `$('#modalBody').html(...)` rendering, add type display. This depends on how the modal body is built — add a type badge in the detail header section. In the detail view header, after the request code display, add:

```js
const typeBadge =
  d.request_type === "오입금"
    ? '<span class="inline-block px-2 py-0.5 rounded text-xs font-black bg-orange-100 text-orange-700 ml-2">오입금</span>'
    : '<span class="inline-block px-2 py-0.5 rounded text-xs font-black bg-blue-100 text-blue-700 ml-2">반환청구</span>';
```

And include `typeBadge` next to the request code in the detail modal header HTML.

**Step 9: Update `openCreateModal()` to include type selector**

In `openCreateModal()` (line 484-527), add a type selector dropdown to the create form. After the `<h2>` title (line 496), add:

```html
<div class="mb-4">
  <label class="text-xs font-bold text-[#404040] mb-0.5 block">신청 유형</label>
  <select id="create_request_type" class="${inputClass}">
    <option value="반환청구">반환청구</option>
    <option value="오입금">오입금</option>
  </select>
</div>
```

In `saveCreate()` (line 529+), in the FormData construction, add:

```js
fd.append("request_type", $("#create_request_type").val());
```

**Step 10: Commit**

```bash
git add public/js/admin.js public/admin.html
git commit -m "feat: add type column, filter, and badges to admin dashboard"
```

---

### Task 8: Final verification and cleanup

**Step 1: Run the database migration**

Run: `node src/dbPush.js`
Expected: Success — `request_type` column added

**Step 2: Start server and test manually**

Run: `npm start`

Test checklist:

- [ ] Public page shows two tabs (반환청구 / 오입금)
- [ ] Tab switching works, status check returns correctly
- [ ] Refund form rejects amounts under 200만원
- [ ] Refund form requires 신분증 file
- [ ] Misdeposit form has no amount minimum
- [ ] Misdeposit form has no 신분증 upload section
- [ ] Both forms submit successfully with correct `request_type` in DB
- [ ] Admin table shows type column with colored badges
- [ ] Admin type filter works
- [ ] Admin detail modal shows type
- [ ] Admin create modal has type selector
- [ ] Excel export includes type column

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat: complete misdeposit form feature with tab UI, conditional validation, and admin support"
```
