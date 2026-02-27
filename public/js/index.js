/**
 * index.js — 공개 폼 페이지 (반환청구 / 오입금 신청)
 *
 * 주요 기능:
 *   - 탭 전환 (반환청구 ↔ 오입금)
 *   - 드래그앤드롭 파일 업로드 (입출금거래내역서, 신분증, 입금내역서)
 *   - 입력값 실시간 포맷팅 (전화번호, 금액, 계좌번호)
 *   - 한글 IME 조합 중 기호 삭제 방지 (compositionstart/end)
 *   - 폼 제출 → 식별코드 발급 + 텍스트 파일 다운로드
 *   - 진행 상태 조회 (식별코드 기반)
 */

// ── XSS 이스케이핑 헬퍼 ──
function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

// ── safeFetch 헬퍼 ──
async function safeFetch(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timer);
        const ct = response.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
            throw new Error('서버가 예상과 다른 응답을 반환했습니다.');
        }
        const data = await response.json();
        return { ok: response.ok, status: response.status, data };
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
            throw new Error('서버 응답 시간이 초과되었습니다.');
        }
        if (err instanceof TypeError || err.message === 'Failed to fetch') {
            throw new Error('서버와 통신할 수 없습니다. 네트워크 연결을 확인해 주세요.');
        }
        throw err;
    }
}

let isSubmitting = false;

// ── 탭 전환 ──
function showRefundTab() {
    document.getElementById('submitSection').classList.remove('hidden');
    document.getElementById('misdepositSection').classList.add('hidden');
    document.getElementById('statusSection').classList.add('hidden');
    document.getElementById('tabRefund').classList.add('tab-active', 'border-blue-600', 'text-blue-600');
    document.getElementById('tabRefund').classList.remove('border-transparent', 'text-gray-400');
    document.getElementById('tabMisdeposit').classList.remove('tab-active', 'border-orange-600', 'text-orange-600');
    document.getElementById('tabMisdeposit').classList.add('border-transparent', 'text-gray-400');
    window.scrollTo(0, 0);
}
function showMisdepositTab() {
    document.getElementById('submitSection').classList.add('hidden');
    document.getElementById('misdepositSection').classList.remove('hidden');
    document.getElementById('statusSection').classList.add('hidden');
    document.getElementById('tabMisdeposit').classList.add('tab-active', 'border-orange-600', 'text-orange-600');
    document.getElementById('tabMisdeposit').classList.remove('border-transparent', 'text-gray-400');
    document.getElementById('tabRefund').classList.remove('tab-active', 'border-blue-600', 'text-blue-600');
    document.getElementById('tabRefund').classList.add('border-transparent', 'text-gray-400');
    window.scrollTo(0, 0);
}
window.showRefundTab = showRefundTab;
window.showMisdepositTab = showMisdepositTab;

// ── 입출금거래내역서 파일 관리 ──
const depositDropZone = document.getElementById('deposit-drop-zone');
const depositFileInput = document.getElementById('deposit-file-upload');
const depositFilePreview = document.getElementById('depositFilePreview');
const depositFileListEl = document.getElementById('depositFileList');
const depositFileCountEl = document.getElementById('depositFileCount');
let selectedDepositFiles = [];

// ── 신분증 파일 관리 ──
const idDropZone = document.getElementById('id-drop-zone');
const idFileInput = document.getElementById('id-file-upload');
const idFilePreview = document.getElementById('idFilePreview');
const idFileListEl = document.getElementById('idFileList');
const idFileCountEl = document.getElementById('idFileCount');
let selectedIdFiles = [];

// 기호 자동 삭제: 한글, 영어, 숫자만 허용
const stripSymbols = v => v.replace(/[^ㄱ-ㅎ가-힣ㅏ-ㅣa-zA-Z0-9]/g, '');
// 상세 사유용: 공백·줄바꿈·마침표 추가 허용
const stripSymbolsText = v => v.replace(/[^ㄱ-ㅎ가-힣ㅏ-ㅣa-zA-Z0-9\s.]/g, '');

// 모든 텍스트 입력에 기호 삭제 적용 (한글 IME 조합 중에는 건너뜀)
document.querySelectorAll('.form-input-custom').forEach(input => {
    let composing = false;
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', e => {
        composing = false;
        e.target.value = stripSymbols(e.target.value);
    });
    input.addEventListener('input', e => {
        if (composing) return;
        e.target.value = stripSymbols(e.target.value);
    });
});

// ── 공통 파일 처리 함수 ──
function setupDropZone(dropZone, fileInput, filesArray, maxCount, handleFn) {
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(e => {
        dropZone.addEventListener(e, (evt) => { evt.preventDefault(); evt.stopPropagation(); }, false);
    });
    ['dragenter', 'dragover'].forEach(e => {
        dropZone.addEventListener(e, () => dropZone.classList.add('drag-over'), false);
    });
    ['dragleave', 'drop'].forEach(e => {
        dropZone.addEventListener(e, () => dropZone.classList.remove('drag-over'), false);
    });
    dropZone.addEventListener('drop', e => handleFn(e.dataTransfer.files));
    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { if (fileInput.files.length > 0) handleFn(fileInput.files); });
}

function handleFilesGeneric(files, filesArray, fileInput, maxCount, label) {
    if (files.length === 0) return;
    const allowed = /(\.png|\.jpg|\.jpeg|\.pdf)$/i;
    for (const file of files) {
        if (filesArray.length >= maxCount) {
            Swal.fire('오류', `${label} 파일은 최대 ${maxCount}개까지 업로드할 수 있습니다.`, 'warning');
            break;
        }
        if (!allowed.exec(file.name)) {
            Swal.fire('오류', `"${file.name}": 이미지 또는 PDF 파일만 업로드 가능합니다.`, 'error');
            continue;
        }
        if (file.size > 10 * 1024 * 1024) {
            Swal.fire('오류', `"${file.name}": 파일 크기가 10MB를 초과합니다.`, 'error');
            continue;
        }
        // 중복 파일 감지 (이름+크기 비교)
        if (filesArray.some(f => f.name === file.name && f.size === file.size)) {
            Swal.fire({ icon: 'info', title: '파일이 이미 추가되어 있습니다.', text: file.name, timer: 2000, showConfirmButton: false, toast: true, position: 'top-end' });
            continue;
        }
        filesArray.push(file);
    }
    fileInput.value = '';
}

function renderFileListGeneric(filesArray, dropZone, filePreview, fileListEl, fileCountEl, addMoreBtnId, removeFn, borderColor, maxCount = 5) {
    if (filesArray.length === 0) {
        dropZone.classList.remove('hidden');
        filePreview.classList.add('hidden');
        return;
    }
    dropZone.classList.add('hidden');
    filePreview.classList.remove('hidden');
    fileCountEl.textContent = filesArray.length;
    document.getElementById(addMoreBtnId).style.display = filesArray.length >= maxCount ? 'none' : '';

    fileListEl.innerHTML = filesArray.map((file, idx) => {
        const isPdf = /\.pdf$/i.test(file.name);
        const icon = isPdf
            ? `<div class="w-12 h-12 bg-red-50 border border-red-200 rounded-md flex items-center justify-center flex-shrink-0"><svg class="w-6 h-6 text-red-400" fill="currentColor" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1"/></svg></div>`
            : `<div class="w-12 h-12 bg-white border rounded-md overflow-hidden flex-shrink-0 file-thumb-${removeFn}" data-idx="${idx}"></div>`;
        return `<div class="flex items-center gap-3 bg-white rounded-md px-3 py-2 border ${borderColor}">
            ${icon}
            <div class="flex-1 min-w-0">
                <p class="text-sm font-bold text-gray-800 truncate">${esc(file.name)}</p>
                <p class="text-xs font-medium text-gray-400">${(file.size / (1024*1024)).toFixed(2)} MB</p>
            </div>
            <button type="button" onclick="${removeFn}(${idx})" class="w-8 h-8 rounded-md text-gray-400 hover:text-red-500 flex items-center justify-center transition-all">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
        </div>`;
    }).join('');

    filesArray.forEach((file, idx) => {
        if (file.type.startsWith('image/')) {
            const thumb = fileListEl.querySelector(`.file-thumb-${removeFn}[data-idx="${idx}"]`);
            if (thumb) {
                const reader = new FileReader();
                reader.onload = e => { thumb.innerHTML = `<img src="${e.target.result}" class="w-full h-full object-cover">`; };
                reader.readAsDataURL(file);
            }
        }
    });
}

// ── 입출금거래내역서 ──
setupDropZone(depositDropZone, depositFileInput, selectedDepositFiles, 5, (files) => {
    handleFilesGeneric(files, selectedDepositFiles, depositFileInput, 5, '입출금거래내역서');
    renderDepositFileList();
});
function renderDepositFileList() {
    renderFileListGeneric(selectedDepositFiles, depositDropZone, depositFilePreview, depositFileListEl, depositFileCountEl, 'depositAddMoreBtn', 'removeDepositFile', 'border-blue-100');
}
function removeDepositFile(idx) { selectedDepositFiles.splice(idx, 1); renderDepositFileList(); }
function clearAllDepositFiles() { selectedDepositFiles = []; depositFileInput.value = ''; renderDepositFileList(); }

// ── 신분증 (1개만) ──
setupDropZone(idDropZone, idFileInput, selectedIdFiles, 1, (files) => {
    handleFilesGeneric(files, selectedIdFiles, idFileInput, 1, '신분증');
    renderIdFileList();
});
function renderIdFileList() {
    renderFileListGeneric(selectedIdFiles, idDropZone, idFilePreview, idFileListEl, idFileCountEl, 'idAddMoreBtn', 'removeIdFile', 'border-green-100', 1);
}
function removeIdFile(idx) { selectedIdFiles.splice(idx, 1); renderIdFileList(); }
function clearAllIdFiles() { selectedIdFiles = []; idFileInput.value = ''; renderIdFileList(); }

// ── 오입금 입금내역서 파일 관리 ──
const mdDepositDropZone = document.getElementById('md-deposit-drop-zone');
const mdDepositFileInput = document.getElementById('md-deposit-file-upload');
const mdDepositFilePreview = document.getElementById('mdDepositFilePreview');
const mdDepositFileListEl = document.getElementById('mdDepositFileList');
const mdDepositFileCountEl = document.getElementById('mdDepositFileCount');
let selectedMdDepositFiles = [];

if (mdDepositDropZone && mdDepositFileInput) {
    setupDropZone(mdDepositDropZone, mdDepositFileInput, selectedMdDepositFiles, 5, (files) => {
        handleFilesGeneric(files, selectedMdDepositFiles, mdDepositFileInput, 5, '입금내역서');
        renderMdDepositFileList();
    });
}
function renderMdDepositFileList() {
    renderFileListGeneric(selectedMdDepositFiles, mdDepositDropZone, mdDepositFilePreview, mdDepositFileListEl, mdDepositFileCountEl, 'mdDepositAddMoreBtn', 'removeMdDepositFile', 'border-orange-100');
}
function removeMdDepositFile(idx) { selectedMdDepositFiles.splice(idx, 1); renderMdDepositFileList(); }
function clearAllMdDepositFiles() { selectedMdDepositFiles = []; mdDepositFileInput.value = ''; renderMdDepositFileList(); }
window.clearAllMdDepositFiles = clearAllMdDepositFiles;
window.removeMdDepositFile = removeMdDepositFile;
window.renderMdDepositFileList = renderMdDepositFileList;

// ── 날짜·시계 초기화 ──
const kstOpts = { timeZone: 'Asia/Seoul' };
const todayKST = new Date().toLocaleDateString('sv-SE', kstOpts); // YYYY-MM-DD 형식
const dateDepositEl = document.getElementById('date_deposit');
if (dateDepositEl) { dateDepositEl.max = todayKST; dateDepositEl.value = todayKST; }

const clockEl = document.getElementById('liveClock');
function updateClock() {
    if (!clockEl) return;
    const now = new Date();
    const dateStr = now.toLocaleDateString('ko-KR', { timeZone:'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit', weekday:'short' });
    const timeStr = now.toLocaleTimeString('ko-KR', { timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
    clockEl.textContent = dateStr + ' ' + timeStr;
}
updateClock();
setInterval(updateClock, 1000);

// ── 공통 입력 포맷터 ──
function formatPhone(e) {
    let v = e.target.value.replace(/\D/g, '').slice(0, 11);
    if (v.length > 3 && v.length <= 7) v = v.slice(0, 3) + '-' + v.slice(3);
    else if (v.length > 7) v = v.slice(0, 3) + '-' + v.slice(3, 7) + '-' + v.slice(7);
    e.target.value = v;
}
function formatAmount(e) {
    let v = e.target.value.replace(/\D/g, '');
    if (v.length > 10) v = v.slice(0, 10);
    if (parseInt(v) > 9999999999) v = "9999999999";
    e.target.value = v.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function formatAccount(e) {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 16);
}

// 반환청구 폼 포맷터
document.getElementById('input_phone')?.addEventListener('input', formatPhone);
document.getElementById('input_amount')?.addEventListener('input', formatAmount);
document.getElementById('input_account')?.addEventListener('input', formatAccount);
document.getElementById('status_code')?.addEventListener('input', e => {
    e.target.value = e.target.value.replace(/[^a-zA-Z0-9\-]/g, '').toUpperCase();
});

// 오입금 폼 포맷터 + 날짜 초기화
const mdDateDepositEl = document.getElementById('md_date_deposit');
if (mdDateDepositEl) {
    mdDateDepositEl.max = todayKST;
    mdDateDepositEl.value = todayKST;
}
document.getElementById('md_input_phone')?.addEventListener('input', formatPhone);
document.getElementById('md_input_amount')?.addEventListener('input', formatAmount);
document.getElementById('md_input_account')?.addEventListener('input', formatAccount);

// ── 공통 textarea 글자수 핸들러 (IME 조합 대응) ──
function setupTextareaCharCount(textareaId, counterId, maxLen = 200) {
    const textarea = document.getElementById(textareaId);
    const counter = document.getElementById(counterId);
    if (!textarea || !counter) return;

    let composing = false;
    const update = () => {
        textarea.value = stripSymbolsText(textarea.value);
        counter.textContent = `${textarea.value.length} / ${maxLen}`;
        counter.classList.toggle('text-red-500', textarea.value.length >= maxLen);
    };
    textarea.addEventListener('compositionstart', () => { composing = true; });
    textarea.addEventListener('compositionend', () => { composing = false; update(); });
    textarea.addEventListener('input', () => { if (!composing) update(); });
}

setupTextareaCharCount('md_input_details', 'md-char-count');
setupTextareaCharCount('input_details', 'char-count');

function openTermsModal() {
    Swal.fire({
        title: '개인정보 수집 동의',
        html: `<div class="text-left text-sm h-48 overflow-y-auto p-4 border rounded bg-gray-50 leading-relaxed font-bold">
                1. 수집항목: 성명, 연락처, 계좌정보, ip정보, 신분증 사본<br>2. 이용목적: 사유서 처리 및 본인확인<br>3. 보유기간: 5년 보관 후 파기
              </div>`,
        confirmButtonText: '확인', confirmButtonColor: '#2563eb'
    });
}

// Global functions need to be attached to window if they are called from HTML onclick attributes
window.openTermsModal = openTermsModal;
window.showStatusCheck = showStatusCheck;
window.showSubmit = showSubmit;
window.checkStatus = checkStatus;
window.clearAllIdFiles = clearAllIdFiles;
window.removeIdFile = removeIdFile;
window.clearAllDepositFiles = clearAllDepositFiles;
window.removeDepositFile = removeDepositFile;
window.renderDepositFileList = renderDepositFileList;
window.renderIdFileList = renderIdFileList;

// ── 공통 폼 제출 핸들러 ──
function setupFormSubmit(formId, { validate, attachFiles, accentColor }) {
    const form = document.getElementById(formId);
    if (!form) return;

    const submitBtn = form.querySelector('button[type="submit"]');
    const origText = submitBtn.textContent;

    form.addEventListener('submit', async e => {
        e.preventDefault();
        if (isSubmitting) return;

        const formData = new FormData(form);

        // 공통 검증
        const errors = [];
        if (!formData.get('applicant_name').trim()) errors.push('이름 필수');
        if (formData.get('applicant_phone').replace(/\D/g, '').length < 10) errors.push('연락처 확인');
        if (!formData.get('deposit_amount')) errors.push('금액 필수');
        if (!formData.get('terms')) errors.push('약관 동의 필수');
        // 폼별 추가 검증
        validate?.(formData, errors);

        if (errors.length > 0) {
            Swal.fire({ icon: 'warning', title: '입력 누락', html: errors.join('<br>') });
            return;
        }

        isSubmitting = true;
        submitBtn.disabled = true;
        submitBtn.textContent = '제출 중\u2026';

        formData.set('deposit_amount', formData.get('deposit_amount').replace(/,/g, ''));
        formData.set('terms_agreed', formData.get('terms') ? '1' : '0');
        attachFiles(formData);

        try {
            const { ok, data: res } = await safeFetch('/api/request', { method: 'POST', body: formData }, 60000);
            if (ok && res.success) {
                downloadCodeAsTxt(res.requestCode);
                const code = String(res.requestCode).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
                let copied = false;
                try { await navigator.clipboard.writeText(res.requestCode); copied = true; } catch {}
                Swal.fire({ icon: 'success', title: '제출 완료', html: `<p class="text-sm text-gray-500 mt-2">식별코드: <strong class="${accentColor} text-xl">${code}</strong></p><p class="text-xs text-gray-400 mt-1">${copied ? '클립보드에 복사되었습니다' : '식별코드를 메모해 주세요'}</p><p class="text-xs text-green-600 mt-1">식별코드 파일이 다운로드되었습니다</p>` })
                    .then(() => location.reload());
            } else {
                Swal.fire('오류', res.error || '제출에 실패했습니다.', 'error');
            }
        } catch (err) {
            console.error('Submit error:', err);
            Swal.fire('오류', err.message, 'error');
        } finally {
            isSubmitting = false;
            submitBtn.disabled = false;
            submitBtn.textContent = origText;
        }
    });
}

// ── 반환청구 폼 제출 ──
setupFormSubmit('requestForm', {
    validate(fd, errors) {
        if (selectedDepositFiles.length === 0) errors.push('입출금거래내역서 파일 필수');
        if (selectedIdFiles.length === 0) errors.push('신분증 파일 필수');
        const amountRaw = Number(fd.get('deposit_amount').replace(/,/g, ''));
        if (amountRaw < 2000000) errors.push('반환 청구는 200만원 이상만 신청 가능합니다');
    },
    attachFiles(fd) {
        selectedDepositFiles.forEach(f => fd.append('deposit_files', f, f.name));
        selectedIdFiles.forEach(f => fd.append('id_card_files', f, f.name));
    },
    accentColor: 'text-blue-600',
});

// ── 오입금 폼 제출 ──
setupFormSubmit('misdepositForm', {
    validate(fd, errors) {
        if (!fd.get('bank_name')?.trim()) errors.push('은행명 필수');
        if (!fd.get('refund_account')?.trim()) errors.push('계좌번호 필수');
        if (!fd.get('contractor_type')?.trim()) errors.push('지사코드 필수');
        if (!fd.get('merchant_type')?.trim()) errors.push('가맹점코드 필수');
        if (!fd.get('deposit_date')) errors.push('입금일자 필수');
        if (selectedMdDepositFiles.length === 0) errors.push('입금내역서 파일 필수');
    },
    attachFiles(fd) {
        selectedMdDepositFiles.forEach(f => fd.append('deposit_files', f, f.name));
    },
    accentColor: 'text-orange-600',
});

// ── 식별코드 텍스트 파일 자동 다운로드 ──
function downloadCodeAsTxt(requestCode) {
    const now = new Date();
    const kstStr = now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const content = [
        '═══════════════════════════════════════',
        '         사유서 식별코드 안내',
        '═══════════════════════════════════════',
        '',
        `  식별코드:  ${requestCode}`,
        `  제출일시:  ${kstStr}`,
        '',
        '───────────────────────────────────────',
        '',
        '  위 식별코드로 진행 상태를 조회할 수 있습니다.',
        '  사유서 제작 홈페이지 → "진행 상태 조회" 버튼',
        '',
        '═══════════════════════════════════════',
    ].join('\r\n');
    const a = document.createElement('a');
    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent('\uFEFF' + content);
    a.download = `사유서_식별코드_${requestCode}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// ── 진행 상태 조회 화면 전환 및 API 호출 ──
function showStatusCheck() {
    document.getElementById('submitSection').classList.add('hidden');
    document.getElementById('misdepositSection').classList.add('hidden');
    document.getElementById('statusSection').classList.remove('hidden');
    document.getElementById('formTabs').classList.add('hidden');
    window.scrollTo(0,0);
}
function showSubmit() {
    document.getElementById('statusSection').classList.add('hidden');
    document.getElementById('formTabs').classList.remove('hidden');
    // Restore whichever tab was active
    if (document.getElementById('tabMisdeposit').classList.contains('tab-active')) {
        showMisdepositTab();
    } else {
        showRefundTab();
    }
}
async function checkStatus() {
    const code = document.getElementById('status_code').value.trim();
    if (!code) {
        Swal.fire('입력 필요', '식별코드를 입력해 주세요.', 'warning');
        return;
    }
    try {
        const { ok, data: res } = await safeFetch(`/api/status/${code}`, {}, 15000);
        if (ok && res.success) {
            document.getElementById('statusResult').classList.remove('hidden');
            document.getElementById('res_status').textContent = res.data.status;
            document.getElementById('res_name').textContent = res.data.applicant_name;
            document.getElementById('res_date').textContent = new Date(res.data.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
            const badge = document.getElementById('res_type_badge');
            const isMisdeposit = res.data.request_type === '오입금';
            badge.textContent = isMisdeposit ? '오입금' : '반환청구';
            badge.className = `inline-block px-3 py-1 rounded-full text-xs font-bold mt-1 ${isMisdeposit ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'}`;
        } else {
            document.getElementById('statusResult').classList.add('hidden');
            Swal.fire('조회 실패', res.error || '해당 식별코드를 찾을 수 없습니다.', 'error');
        }
    } catch (err) { Swal.fire('오류', err.message, 'error'); }
}
