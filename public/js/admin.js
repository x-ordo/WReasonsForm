/**
 * admin.js — 관리자 대시보드
 *
 * 주요 기능:
 *   - 로그인/로그아웃 (세션 기반)
 *   - DataTables 기반 목록 표시 (커스텀 필터, 정렬, 페이징)
 *   - 상세보기 모달 (파일 미리보기, 인라인 파일 추가/삭제)
 *   - 수정 모드 (필드 수정 + 파일 관리)
 *   - 신규 등록 모달
 *   - 상태 변경 (드롭다운 즉시 변경)
 *   - 일괄 삭제, 엑셀 내보내기, Word 다운로드, 인쇄
 */

// ── 전역 상태 ──
let table;                           // DataTables 인스턴스
let allData = [];                    // 전체 요청 데이터 (서버 응답 원본)
let dataById = new Map();            // id → 데이터 빠른 조회용 맵
let currentDetailId = null;          // 현재 열린 상세보기의 요청 ID
let isEditMode = false;              // 수정 모드 여부
let modalMode = 'view';              // 모달 모드: 'view' | 'edit' | 'create'
let isSaving = false;                // 저장 중 중복 방지 플래그
const statuses = ['대기', '접수', '처리중', '완료', '반려'];

// ── safeFetch 헬퍼 (401 세션 만료 자동 처리) ──
async function safeFetch(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        options.credentials = 'include';
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timer);
        // 세션 만료 처리
        if (response.status === 401) {
            await Swal.fire({ icon: 'warning', title: '세션 만료', text: '로그인 세션이 만료되었습니다. 다시 로그인해 주세요.', confirmButtonText: '확인' });
            location.reload();
            return { ok: false, status: 401, data: { success: false, error: '세션 만료' } };
        }
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

// XSS 방어: HTML 특수문자 이스케이프
function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

// ── 초기화: 세션 확인 후 관리자 화면 표시 ──
$(document).ready(async () => {
    try {
        const resp = await fetch('/api/admin/me', { credentials: 'include' });
        if (resp.ok) {
            const me = await resp.json();
            if (me.success) showAdmin(me.user);
        }
    } catch (e) { /* 미인증 상태 — 로그인 화면 유지 */ }
});

// ── 포맷 헬퍼 ──
const _dateFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
function fmtDate(d) {
    if (!d) return '-';
    return _dateFmt.format(new Date(d)).replace(/\s/g, '');
}

function fmtPhone(p) {
    if (!p) return '-';
    return p.replace(/(\d{3})(\d{3,4})(\d{4})/, '$1-$2-$3');
}

// ── 관리자 화면 초기화 (DataTables 설정 + 이벤트 바인딩) ──
function showAdmin(user) {
    $('#loginOverlay').hide(); $('#adminContent').removeClass('hidden');
    $('#adminInfo').text(`${user.name} 님`);

    table = $('#requestTable').DataTable({
        dom: '<"dt-top">rt<"dt-bottom"ip>',
        order: [[1, 'desc']],
        pageLength: 25,
        columnDefs: [
            { orderable: false, className: 'select-checkbox', targets: 0 },
            { orderable: false, targets: [4, 5, 6, 7, 10, 11, 12] },
            { className: 'dt-center', targets: '_all' }
        ],
        select: { style: 'multi', selector: 'td:first-child' },
        language: {
            info: "총 _TOTAL_ 건 중 _START_-_END_",
            infoEmpty: "데이터 없음",
            infoFiltered: "(검색: _MAX_ 건)",
            zeroRecords: "검색 결과 없음",
            paginate: { previous: "‹", next: "›" }
        },
        autoWidth: false
    });

    // 전체 선택 체크박스
    $('#selectAll').on('change', (e) => {
        if (e.target.checked) {
            table.rows({ search: 'applied' }).select();
        } else {
            table.rows().deselect();
        }
    });
    table.on('select deselect', () => {
        const allRows = table.rows({ search: 'applied' }).count();
        const selectedRows = table.rows({ selected: true }).count();
        $('#selectAll').prop('checked', allRows > 0 && allRows === selectedRows);
        // 일괄 삭제 버튼 표시/숨김
        if (selectedRows > 0) {
            $('#btnBulkDelete').removeClass('hidden').addClass('flex');
            $('#bulkDeleteLabel').text(`선택 삭제 (${selectedRows}건)`);
        } else {
            $('#btnBulkDelete').addClass('hidden').removeClass('flex');
        }
    });

    // 커스텀 검색 (디바운스 + allData 기반)
    let searchTimer = null;
    $('#customSearch').on('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { syncFilterCache(); table.draw(); updateFilterCount(); }, 200);
    });

    // 커스텀 건수
    $('#customPageLength').on('change', (e) => {
        table.page.len(parseInt(e.target.value)).draw();
    });

    $('#requestTable tbody').on('click', 'tr', function (e) {
        if ($(e.target).closest('td').hasClass('select-checkbox') || $(e.target).hasClass('list-status-select')) return;
        const data = table.row(this).data();
        if (!data) return;
        const id = $(data[12]).data('id');
        if (id) openDetail(id);
    });

    loadData();
}

// ── 데이터 로드: 서버에서 전체 목록 가져와 테이블 갱신 ──
async function loadData() {
    let res;
    try {
        const result = await safeFetch('/api/admin/requests');
        res = result.data;
    } catch (err) {
        Swal.fire('오류', err.message || '목록을 불러올 수 없습니다.', 'error');
        return;
    }
    if (res.success) {
        // 필터 상태 보존
        const prevContractor = $('#filter_contractor').val() || '';
        const prevMerchant = $('#filter_merchant').val() || '';
        const prevStatus = $('#filter_status').val() || '';
        const prevType = $('#filter_type').val() || '';
        const prevSearch = $('#customSearch').val() || '';

        allData = res.data; table.clear();
        dataById = new Map(allData.map(d => [d.id, d]));
        const merchants = new Set();
        const contractors = new Set();

        allData.forEach(i => {
            if (i.merchant_code) merchants.add(i.merchant_code);
            if (i.contractor_code) contractors.add(i.contractor_code);

            let statusDd = '';
            if (i.status === '완료') {
                statusDd = `<span class="list-status-text status-완료">완료</span>`;
            } else {
                let statusOptions = statuses.map(s => `<option value="${s}" ${i.status === s ? 'selected' : ''}>${s}</option>`).join('');
                statusDd = `<select data-status-change="${i.id}" class="list-status-select status-${i.status}">${statusOptions}</select>`;
            }

            const accountInfo = [i.bank_name, i.user_account, i.user_account_name].filter(Boolean).map(esc).join(' ');

            table.row.add([
                '',
                fmtDate(i.request_date),
                `<span class="font-mono font-bold text-[#1A1A1A]">${esc(i.request_code)}</span>`,
                i.request_type === '오입금'
                    ? '<span class="inline-block px-2 py-0.5 rounded text-xs font-black bg-orange-100 text-orange-700">오입금</span>'
                    : '<span class="inline-block px-2 py-0.5 rounded text-xs font-black bg-blue-100 text-blue-700">반환청구</span>',
                esc(i.contractor_code) || '-',
                esc(i.merchant_code) || '-',
                `<span class="font-semibold text-[#1A1A1A]">${esc(i.applicant_name)}</span>`,
                `<span class="font-mono text-[14px] text-[#737373]">${fmtPhone(i.applicant_phone)}</span>`,
                fmtDate(i.deposit_date) + (i.deposit_time ? ' ' + i.deposit_time : ''),
                `<span class="font-bold text-[#1A1A1A]">${Number(i.deposit_amount).toLocaleString()}</span>`,
                `<span class="text-[14px] text-[#737373]">${accountInfo}</span>`,
                statusDd,
                `<span class="text-[13px] text-[#A3A3A3] underline underline-offset-2 cursor-pointer hover:text-[#1A1A1A]" data-id="${i.id}">보기</span>`
            ]);
        });

        // 필터 드롭다운 재구성
        const cFilter = $('#filter_contractor').empty().append('<option value="">계약자 코드: 전체</option>');
        Array.from(contractors).sort().forEach(c => cFilter.append(`<option value="${esc(c)}">${esc(c)}</option>`));
        const mFilter = $('#filter_merchant').empty().append('<option value="">가맹점 코드: 전체</option>');
        Array.from(merchants).sort().forEach(m => mFilter.append(`<option value="${esc(m)}">${esc(m)}</option>`));

        // 필터 상태 복원
        if (prevContractor) { $('#filter_contractor').val(prevContractor).toggleClass('filter-active', true); }
        if (prevMerchant) { $('#filter_merchant').val(prevMerchant).toggleClass('filter-active', true); }
        if (prevStatus) { $('#filter_status').val(prevStatus).toggleClass('filter-active', true); }
        if (prevType) { $('#filter_type').val(prevType).toggleClass('filter-active', true); }
        if (prevSearch) { $('#customSearch').val(prevSearch); }

        syncFilterCache();
        table.draw();
        updateFilterCount();
    }
}

// ── 목록에서 상태 드롭다운 즉시 변경 ──
async function updateStatusDirect(id, sel) {
    const newStatus = sel.value;
    const prevStatus = dataById.get(id)?.status || sel.dataset.prev || '대기';
    try {
        const { ok, data: json } = await safeFetch('/api/admin/status', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, status: newStatus })
        });
        if (ok && json.success) {
            Swal.fire({ icon: 'success', title: newStatus, timer: 600, showConfirmButton: false, position: 'top-end', toast: true });
            await loadData(); // '완료' 시 드롭다운 -> 텍스트 전환 등을 위해 전체 다시 불러오기
        } else {
            // 실패 시 이전 상태로 롤백
            sel.value = prevStatus;
            sel.className = `list-status-select status-${prevStatus}`;
            Swal.fire('상태 변경 실패', json.error || '서버 오류가 발생했습니다.', 'error');
        }
    } catch (err) {
        sel.value = prevStatus;
        sel.className = `list-status-select status-${prevStatus}`;
        Swal.fire('오류', err.message, 'error');
    }
}

// ── DataTables 커스텀 필터 ──
// allData 원본을 기반으로 필터링 (HTML 마크업 무시)
// 캐시: draw() 전에 필터 값을 한 번만 읽어 행마다 DOM 접근 방지
let cachedFC = '', cachedFM = '', cachedFS = '', cachedFT = '', cachedQ = '';

$.fn.dataTable.ext.search.push(function(settings, data, dataIndex) {
    const rowData = table.row(dataIndex).data();
    if (!rowData) return true;

    // 행의 data-id로 allData에서 원본 찾기
    const id = $(rowData[12]).data('id');
    const item = dataById.get(id);
    if (!item) return true;

    // 필터: 계약자 코드
    if (cachedFC && item.contractor_code !== cachedFC) return false;

    // 필터: 가맹점 코드
    if (cachedFM && item.merchant_code !== cachedFM) return false;

    // 필터: 상태 (원본 status 필드로 정확 매칭)
    if (cachedFS && item.status !== cachedFS) return false;

    // 필터: 유형
    if (cachedFT && item.request_type !== cachedFT) return false;

    // 텍스트 검색 (원본 데이터 필드만 대상)
    if (cachedQ) {
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
            String(item.deposit_amount)
        ].map(v => (v || '').toLowerCase());
        if (!searchFields.some(f => f.includes(cachedQ))) return false;
    }

    return true;
});

// 필터 캐시 갱신 헬퍼 — draw() 호출 전에 실행
function syncFilterCache() {
    cachedFC = $('#filter_contractor').val() || '';
    cachedFM = $('#filter_merchant').val() || '';
    cachedFS = $('#filter_status').val() || '';
    cachedFT = $('#filter_type').val() || '';
    cachedQ  = ($('#customSearch').val() || '').trim().toLowerCase();
}

// 필터 변경 시 draw (커스텀 필터가 처리) + 활성 스타일
$('#filter_contractor, #filter_merchant, #filter_status, #filter_type').on('change', (e) => {
    $(e.target).toggleClass('filter-active', !!e.target.value);
    syncFilterCache();
    table.draw();
    updateFilterCount();
});

function updateFilterCount() {
    const total = allData.length;
    const filtered = table.rows({ search: 'applied' }).count();
    const el = $('#filterCount');
    if (filtered < total) {
        el.text(`${filtered} / ${total}건 표시`).removeClass('hidden');
    } else {
        el.addClass('hidden');
    }
}

function resetFilters() {
    $('#filter_contractor, #filter_merchant, #filter_status, #filter_type').val('').removeClass('filter-active');
    $('#customSearch').val('');
    syncFilterCache();
    table.draw();
    updateFilterCount();
}

// ── 상세보기 모달 (파일 미리보기 + 인라인 파일 추가/삭제) ──
async function openDetail(id) {
    const d = dataById.get(id);
    if (!d) return;
    currentDetailId = id;
    isEditMode = false;
    modalMode = 'view';
    $('#btnEdit, #btnDelete, #btnPrint, #btnDownloadWord').show();
    $('#btnSaveEdit, #btnSaveCreate, #btnCancelEdit').hide();
    $('#detailModal').data('code', d.request_code);

    // Fetch full detail including files
    let files = [];
    let filesFetchError = false;
    try {
        const { ok, data: detailRes } = await safeFetch(`/api/admin/request/${id}`);
        if (ok && detailRes.success && detailRes.data?.files) {
            files = detailRes.data.files;
        }
    } catch (e) { filesFetchError = true; }

    // Store files on current detail data for edit mode
    d._files = files;

    // Group files by category (입출금거래내역서 = legacy name for 입출금내역서)
    const isDepositFile = f => f.category === '입출금내역서' || f.category === '입출금거래내역서';
    const depositFiles = files.filter(isDepositFile);
    const idCardFiles = files.filter(f => !isDepositFile(f));

    function renderFilesSection(fileList, category) {
        let html = '';
        if (fileList.length > 0) {
            html = fileList.map(f => {
                const src = `/uploads/${encodeURIComponent(f.filename)}`;
                const isPdf = f.file_type === 'pdf';
                const deleteBtn = `<button data-delete-file="${id}" data-file-id="${f.id}" class="no-print text-xs font-bold text-red-400 hover:text-red-600 border border-red-200 rounded px-2 py-0.5 transition-colors flex-shrink-0" title="삭제">&#10005;</button>`;
                if (isPdf) {
                    return `<div class="border border-[#E5E5E5] rounded-md overflow-hidden mb-2">
                        <iframe src="${src}" class="w-full" style="height:300px;" frameborder="0"></iframe>
                        <div class="px-3 py-2 bg-[#F5F5F5] flex items-center justify-between gap-2">
                            <span class="text-xs text-[#737373] truncate">${esc(f.original_name)}</span>
                            <div class="flex items-center gap-2 flex-shrink-0">
                                <a href="${src}" target="_blank" class="text-xs font-bold text-blue-600 hover:underline">새 탭</a>
                                ${deleteBtn}
                            </div>
                        </div>
                    </div>`;
                } else {
                    return `<div class="mb-2">
                        <img src="${src}" alt="${esc(f.original_name)}" class="max-w-full rounded cursor-pointer" data-zoom-image tabindex="0" role="button" style="max-height: 240px;" loading="lazy">
                        <div class="flex items-center justify-between mt-1">
                            <p class="text-xs text-[#A3A3A3] truncate">${esc(f.original_name)}</p>
                            ${deleteBtn}
                        </div>
                    </div>`;
                }
            }).join('');
        } else {
            html = '<p class="text-[#D4D4D4] text-xs">없음</p>';
        }
        // 파일 추가 입력 (5개 미만일 때만 표시)
        const fieldName = (category === '입출금내역서' || category === '입출금거래내역서') ? 'deposit_files' : 'id_card_files';
        const remaining = 5 - fileList.length;
        if (remaining > 0) {
            html += `<div class="no-print mt-2 pt-2 border-t border-[#E5E5E5]">
                <label class="inline-flex items-center gap-1.5 cursor-pointer text-xs font-bold text-blue-500 hover:text-blue-700 transition-colors">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4"/></svg>
                    파일 추가
                    <input type="file" accept=".jpg,.jpeg,.png,.pdf" multiple class="hidden" data-add-files="${id}" data-field="${fieldName}" data-remaining="${remaining}">
                </label>
                <span class="text-[10px] text-[#A3A3A3] ml-2">${remaining}개 추가 가능 · PNG/JPG/PDF</span>
            </div>`;
        } else {
            html += `<div class="no-print mt-2 pt-2 border-t border-[#E5E5E5]">
                <span class="text-[10px] text-[#A3A3A3]">최대 5개 도달</span>
            </div>`;
        }
        return html;
    }

    const depositFilesHTML = renderFilesSection(depositFiles, '입출금내역서');
    const idCardFilesHTML = renderFilesSection(idCardFiles, '신분증');

    const typeBadge = d.request_type === '오입금'
        ? '<span class="inline-block px-2 py-0.5 rounded text-xs font-black bg-orange-100 text-orange-700 ml-2">오입금</span>'
        : '<span class="inline-block px-2 py-0.5 rounded text-xs font-black bg-blue-100 text-blue-700 ml-2">반환청구</span>';

    $('#modalBody').html(`
        <!-- 문서 제목 -->
        <h2 class="text-center text-base sm:text-lg font-black text-[#1A1A1A] tracking-tight pb-3 mb-4 sm:mb-5 border-b-2 border-[#1A1A1A]">${d.request_type === '오입금' ? '오입금 포인트 신청서' : '반환 청구 사유서'}</h2>

        <!-- 상단: 코드 + 상태 -->
        <div class="flex justify-between items-start mb-4 sm:mb-5">
            <div>
                <p class="text-xs text-[#A3A3A3] mb-0.5">식별코드</p>
                <p class="font-mono font-bold text-sm sm:text-base text-[#1A1A1A]">${esc(d.request_code)}${typeBadge}</p>
            </div>
            <div class="text-right">
                <p class="text-xs text-[#A3A3A3] mb-0.5">진행 상태</p>
                <p class="font-bold text-xl status-${esc(d.status)}">${esc(d.status)}</p>
            </div>
        </div>

        <!-- 정보 테이블 -->
        <table class="w-full border-collapse mb-4 sm:mb-5 hidden sm:table" style="border: 1px solid #D4D4D4;">
            <tr>
                <th class="bg-[#F5F5F5] border border-[#D4D4D4] px-3 py-2.5 text-left text-[#404040] font-bold text-sm w-[120px]">신청인</th>
                <td class="border border-[#D4D4D4] px-3 py-2.5 text-[#1A1A1A] font-semibold text-sm">${esc(d.applicant_name)}</td>
                <th class="bg-[#F5F5F5] border border-[#D4D4D4] px-3 py-2.5 text-left text-[#404040] font-bold text-sm w-[120px]">연락처</th>
                <td class="border border-[#D4D4D4] px-3 py-2.5 text-[#1A1A1A] font-mono text-sm">${fmtPhone(d.applicant_phone)}</td>
            </tr>
            <tr>
                <th class="bg-[#F5F5F5] border border-[#D4D4D4] px-3 py-2.5 text-left text-[#404040] font-bold text-sm">계약자 코드</th>
                <td class="border border-[#D4D4D4] px-3 py-2.5 text-[#1A1A1A] text-sm">${esc(d.contractor_code) || '-'}</td>
                <th class="bg-[#F5F5F5] border border-[#D4D4D4] px-3 py-2.5 text-left text-[#404040] font-bold text-sm">가맹점 코드</th>
                <td class="border border-[#D4D4D4] px-3 py-2.5 text-[#1A1A1A] text-sm">${esc(d.merchant_code)}</td>
            </tr>
            <tr>
                <th class="bg-[#F5F5F5] border border-[#D4D4D4] px-3 py-2.5 text-left text-[#404040] font-bold text-sm">신청일</th>
                <td class="border border-[#D4D4D4] px-3 py-2.5 text-[#1A1A1A] text-sm">${fmtDate(d.request_date)}</td>
                <th class="bg-[#F5F5F5] border border-[#D4D4D4] px-3 py-2.5 text-left text-[#404040] font-bold text-sm">입금일시</th>
                <td class="border border-[#D4D4D4] px-3 py-2.5 text-[#1A1A1A] text-sm">${fmtDate(d.deposit_date)}${d.deposit_time ? ' ' + d.deposit_time : ''}</td>
            </tr>
            <tr>
                <th class="bg-[#F5F5F5] border border-[#D4D4D4] px-3 py-2.5 text-left text-[#404040] font-bold text-sm">입금액</th>
                <td class="border border-[#D4D4D4] px-3 py-2.5 text-[#1A1A1A] font-bold text-base" colspan="3">${Number(d.deposit_amount).toLocaleString()}원</td>
            </tr>
            <tr>
                <th class="bg-[#F5F5F5] border border-[#D4D4D4] px-3 py-2.5 text-left text-[#404040] font-bold text-sm">사용계좌</th>
                <td class="border border-[#D4D4D4] px-3 py-2.5 text-[#1A1A1A] font-semibold text-sm" colspan="3">${esc(d.bank_name)} / ${esc(d.user_account)} / ${esc(d.user_account_name)}</td>
            </tr>
        </table>
        <!-- 모바일 카드형 정보 -->
        <div class="sm:hidden space-y-0 mb-4 border border-[#D4D4D4] rounded-lg overflow-hidden">
            <div class="grid grid-cols-2">
                <div class="bg-[#F5F5F5] px-3 py-2 border-b border-r border-[#D4D4D4]"><span class="text-xs font-bold text-[#404040]">신청인</span><p class="text-sm font-semibold text-[#1A1A1A] mt-0.5">${esc(d.applicant_name)}</p></div>
                <div class="bg-[#F5F5F5] px-3 py-2 border-b border-[#D4D4D4]"><span class="text-xs font-bold text-[#404040]">연락처</span><p class="text-sm font-mono text-[#1A1A1A] mt-0.5">${fmtPhone(d.applicant_phone)}</p></div>
            </div>
            <div class="grid grid-cols-2">
                <div class="px-3 py-2 border-b border-r border-[#D4D4D4]"><span class="text-xs font-bold text-[#404040]">계약자 코드</span><p class="text-sm text-[#1A1A1A] mt-0.5">${esc(d.contractor_code) || '-'}</p></div>
                <div class="px-3 py-2 border-b border-[#D4D4D4]"><span class="text-xs font-bold text-[#404040]">가맹점 코드</span><p class="text-sm text-[#1A1A1A] mt-0.5">${esc(d.merchant_code)}</p></div>
            </div>
            <div class="grid grid-cols-2">
                <div class="px-3 py-2 border-b border-r border-[#D4D4D4]"><span class="text-xs font-bold text-[#404040]">신청일</span><p class="text-sm text-[#1A1A1A] mt-0.5">${fmtDate(d.request_date)}</p></div>
                <div class="px-3 py-2 border-b border-[#D4D4D4]"><span class="text-xs font-bold text-[#404040]">입금일시</span><p class="text-sm text-[#1A1A1A] mt-0.5">${fmtDate(d.deposit_date)}${d.deposit_time ? ' ' + d.deposit_time : ''}</p></div>
            </div>
            <div class="px-3 py-2 border-b border-[#D4D4D4]"><span class="text-xs font-bold text-[#404040]">입금액</span><p class="text-sm font-bold text-[#1A1A1A] mt-0.5">${Number(d.deposit_amount).toLocaleString()}원</p></div>
            <div class="px-3 py-2"><span class="text-xs font-bold text-[#404040]">사용계좌</span><p class="text-sm font-semibold text-[#1A1A1A] mt-0.5">${esc(d.bank_name)} / ${esc(d.user_account)} / ${esc(d.user_account_name)}</p></div>
        </div>

        <!-- 사유 -->
        <div class="mb-4 sm:mb-5">
            <p class="text-xs sm:text-sm font-bold text-[#404040] mb-1.5">상세 사유</p>
            <div class="border border-[#D4D4D4] px-3 py-3 sm:px-4 sm:py-3 min-h-[48px] sm:min-h-[60px] text-sm text-[#1A1A1A] leading-relaxed whitespace-pre-wrap">${esc(d.details) || '내용 없음'}</div>
        </div>

        <!-- 입출금내역서 -->
        <div class="mb-4 sm:mb-5">
            <p class="text-xs sm:text-sm font-bold text-[#404040] mb-1.5">입출금내역서 (${depositFiles.length}개)</p>
            <div class="border border-[#D4D4D4] p-2 sm:p-3 min-h-[60px] bg-[#FAFAFA]">${depositFilesHTML}</div>
        </div>

        <!-- 신분증 (반환청구만 표시) -->
        ${d.request_type !== '오입금' ? `<div class="mb-4 sm:mb-5">
            <p class="text-xs sm:text-sm font-bold text-[#404040] mb-1.5">신분증 (${idCardFiles.length}개)</p>
            <div class="border border-[#D4D4D4] p-2 sm:p-3 min-h-[60px] bg-[#FAFAFA]">${idCardFilesHTML}</div>
        </div>` : ''}

        <!-- 동의 정보 -->
        <div class="bg-[#F5F5F5] border border-[#E5E5E5] rounded-md px-3 py-2.5 sm:px-4 sm:py-3">
            <p class="text-xs font-bold text-[#404040] mb-1.5">개인정보 동의 정보</p>
            <div class="flex gap-4 text-xs">
                <span class="text-[#737373]">동의 여부: <strong class="${d.terms_agreed ? 'text-green-600' : 'text-red-600'}">${d.terms_agreed ? 'O' : 'X'}</strong></span>
                <span class="text-[#737373]">동의 IP: <strong class="text-[#1A1A1A] font-mono">${esc(d.terms_ip) || '-'}</strong></span>
            </div>
        </div>
    `);
    $('#detailModal').removeClass('hidden');
}

function closeModal() { $('#detailModal').addClass('hidden'); isEditMode = false; modalMode = 'view'; }

// ── 신규 등록 모달 ──
function openCreateModal() {
    currentDetailId = null;
    isEditMode = false;
    modalMode = 'create';
    // Hide view/edit buttons, show create button
    $('#btnEdit, #btnDelete, #btnPrint, #btnDownloadWord').hide();
    $('#btnSaveCreate, #btnCancelEdit').removeClass('hidden').show();

    const today = new Date().toISOString().slice(0, 10);
    const inputClass = 'w-full border border-[#D4D4D4] rounded px-3 py-1.5 text-sm font-medium text-[#1A1A1A] outline-none focus:border-[#A3A3A3]';

    $('#modalBody').html(`
        <h2 class="text-center text-base sm:text-lg font-black text-[#1A1A1A] tracking-tight pb-3 mb-4 sm:mb-5 border-b-2 border-[#1A1A1A]">신규 사유서 등록</h2>
        <div class="mb-4">
            <label class="text-xs font-bold text-[#404040] mb-0.5 block">신청 유형</label>
            <select id="create_request_type" class="${inputClass}">
                <option value="반환청구">반환청구</option>
                <option value="오입금">오입금</option>
            </select>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            <div><label class="text-xs font-bold text-[#404040] mb-0.5 block">신청인 <span class="text-red-500">*</span></label><input id="create_applicant_name" class="${inputClass}" maxlength="20" placeholder="홍길동"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-0.5 block">연락처 <span class="text-red-500">*</span></label><input id="create_applicant_phone" class="${inputClass}" maxlength="11" placeholder="01012345678"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-0.5 block">계약자 코드 <span class="text-red-500">*</span></label><input id="create_contractor_type" class="${inputClass}" placeholder="계약자 코드"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-0.5 block">가맹점 코드 <span class="text-red-500">*</span></label><input id="create_merchant_type" class="${inputClass}" placeholder="가맹점 코드"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-0.5 block">신청일 <span class="text-red-500">*</span></label><input id="create_request_date" type="date" class="${inputClass}" value="${today}"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-0.5 block">입금일 <span class="text-red-500">*</span></label><input id="create_deposit_date" type="date" class="${inputClass}"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-0.5 block">입금시간 <span class="text-red-500">*</span></label><input id="create_deposit_time" type="time" step="1" class="${inputClass}"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-0.5 block">입금액 <span class="text-red-500">*</span></label><input id="create_deposit_amount" type="number" class="${inputClass}" placeholder="0"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-0.5 block">은행명 <span class="text-red-500">*</span></label><input id="create_bank_name" class="${inputClass}" maxlength="20" placeholder="은행명"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-0.5 block">사용계좌 <span class="text-red-500">*</span></label><input id="create_refund_account" class="${inputClass}" maxlength="16" placeholder="계좌번호 (숫자만)"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-0.5 block">예금주 <span class="text-red-500">*</span></label><input id="create_refund_account_name" class="${inputClass}" maxlength="20" placeholder="예금주명"></div>
        </div>
        <div class="mb-3">
            <label class="text-xs font-bold text-[#404040] mb-0.5 block">상세 사유</label>
            <textarea id="create_details" class="${inputClass}" rows="2" maxlength="200" placeholder="상세 사유를 입력하세요"></textarea>
        </div>
        <div class="mb-3">
            <label class="text-xs font-bold text-[#404040] mb-0.5 block">입출금내역서 (최대 5개, PNG/JPG/PDF)</label>
            <input type="file" id="create_deposit_files" accept=".jpg,.jpeg,.png,.pdf" multiple class="text-xs text-[#737373]">
        </div>
        <div class="mb-3" id="create_id_card_section">
            <label class="text-xs font-bold text-[#404040] mb-0.5 block">신분증 (최대 5개, PNG/JPG/PDF)</label>
            <input type="file" id="create_id_card_files" accept=".jpg,.jpeg,.png,.pdf" multiple class="text-xs text-[#737373]">
        </div>
        <div class="flex items-center gap-2">
            <input type="checkbox" id="create_terms_agreed" class="cursor-pointer" style="width:14px;height:14px;">
            <label for="create_terms_agreed" class="text-xs font-medium text-[#737373] cursor-pointer">개인정보 수집 및 이용 동의</label>
        </div>
    `);
    // 오입금 선택 시 신분증 섹션 숨기기
    $('#create_request_type').on('change', (e) => {
        $('#create_id_card_section').toggle(e.target.value !== '오입금');
    });
    $('#detailModal').removeClass('hidden');
}

// ── 신규 등록 저장 ──
async function saveCreate() {
    if (isSaving) return;

    // 클라이언트 필수 필드 검증
    const createFields = {
        '#create_applicant_name': '신청인 이름',
        '#create_applicant_phone': '연락처',
        '#create_contractor_type': '계약자 코드',
        '#create_merchant_type': '가맹점 코드',
        '#create_request_date': '신청일자',
        '#create_deposit_date': '입금일자',
        '#create_deposit_time': '입금시간',
        '#create_deposit_amount': '입금액',
        '#create_bank_name': '은행명',
        '#create_refund_account': '환불계좌',
        '#create_refund_account_name': '예금주'
    };
    const missing = [];
    for (const [sel, label] of Object.entries(createFields)) {
        if (!$(sel).val() || !$(sel).val().trim()) missing.push(label);
    }
    if (missing.length > 0) {
        Swal.fire({ icon: 'warning', title: '필수 항목 누락', html: missing.map(m => `<span class="text-sm">${m}</span>`).join(', ') });
        return;
    }

    isSaving = true;
    const saveBtn = $('#btnSaveCreate');
    saveBtn.prop('disabled', true).text('저장 중\u2026');

    const fd = new FormData();
    fd.append('applicant_name', $('#create_applicant_name').val());
    fd.append('applicant_phone', $('#create_applicant_phone').val());
    fd.append('contractor_type', $('#create_contractor_type').val());
    fd.append('merchant_type', $('#create_merchant_type').val());
    fd.append('request_date', $('#create_request_date').val());
    fd.append('deposit_date', $('#create_deposit_date').val());
    fd.append('deposit_time', $('#create_deposit_time').val());
    fd.append('deposit_amount', $('#create_deposit_amount').val());
    fd.append('bank_name', $('#create_bank_name').val());
    fd.append('refund_account', $('#create_refund_account').val());
    fd.append('refund_account_name', $('#create_refund_account_name').val());
    fd.append('details', $('#create_details').val());
    fd.append('request_type', $('#create_request_type').val());
    fd.append('terms_agreed', $('#create_terms_agreed').is(':checked') ? '1' : '0');

    const createDepositInput = document.getElementById('create_deposit_files');
    if (createDepositInput?.files.length > 0) {
        for (const f of createDepositInput.files) fd.append('deposit_files', f);
    }
    const createIdInput = document.getElementById('create_id_card_files');
    if (createIdInput?.files.length > 0) {
        for (const f of createIdInput.files) fd.append('id_card_files', f);
    }

    try {
        const { ok, data: json } = await safeFetch('/api/admin/request', { method: 'POST', body: fd }, 60000);
        if (ok && json.success) {
            closeModal();
            await loadData();
            Swal.fire({ icon: 'success', title: '등록 완료', html: `<p class="text-sm text-gray-500">식별코드: <strong>${esc(json.requestCode)}</strong></p>`, timer: 2000, showConfirmButton: false });
        } else {
            Swal.fire('등록 실패', json.error || '서버 오류가 발생했습니다.', 'error');
        }
    } catch (err) {
        Swal.fire('오류', err.message, 'error');
    } finally {
        isSaving = false;
        saveBtn.prop('disabled', false).text('저장');
    }
}

// ── 선택 항목 일괄 삭제 ──
async function bulkDelete() {
    if (isSaving) return;
    const selectedRows = table.rows({ selected: true }).data().toArray();
    if (selectedRows.length === 0) return;

    // 선택된 행에서 ID + request_code 추출
    const items = selectedRows.map(r => ({
        id: $(r[12]).data('id'),
        code: $(r[2]).text()
    })).filter(i => i.id);
    if (items.length === 0) return;

    const result = await Swal.fire({
        title: `${items.length}건을 삭제하시겠습니까?`,
        html: `<p class="text-sm text-red-500">이 작업은 되돌릴 수 없습니다.</p>`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#DC2626',
        confirmButtonText: `${items.length}건 삭제`,
        cancelButtonText: '취소'
    });
    if (!result.isConfirmed) return;

    isSaving = true;
    const bulkBtn = $('#btnBulkDelete button, #btnBulkDelete');
    bulkBtn.prop('disabled', true);
    Swal.fire({ title: '삭제 중\u2026', didOpen: () => Swal.showLoading(), allowOutsideClick: false });

    let successCount = 0;
    const failedCodes = [];
    for (const item of items) {
        try {
            const { ok, data: json } = await safeFetch(`/api/admin/request/${item.id}`, { method: 'DELETE' });
            if (ok && json.success) successCount++;
            else failedCodes.push(item.code);
        } catch (err) { failedCodes.push(item.code); }
    }

    await loadData();
    table.rows().deselect();

    if (failedCodes.length === 0) {
        Swal.fire({ icon: 'success', title: `${successCount}건 삭제 완료`, timer: 1500, showConfirmButton: false });
    } else {
        Swal.fire({
            icon: 'warning',
            title: '일부 실패',
            html: `<p class="text-sm">성공: ${successCount}건 / 실패: ${failedCodes.length}건</p><p class="text-xs text-red-500 mt-2">실패 항목: ${failedCodes.map(c => `<code>${esc(c)}</code>`).join(', ')}</p>`
        });
    }
    isSaving = false;
    bulkBtn.prop('disabled', false);
}

// ── 한국 시간 실시간 시계 ──
const adminClockEl = document.getElementById('adminClock');
function updateAdminClock() {
    if (!adminClockEl) return;
    const now = new Date();
    const dateStr = now.toLocaleDateString('ko-KR', { timeZone:'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit', weekday:'short' });
    const timeStr = now.toLocaleTimeString('ko-KR', { timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
    adminClockEl.textContent = `${dateStr} ${timeStr}`;
}
updateAdminClock();
setInterval(updateAdminClock, 1000);

function logout() { fetch('/api/admin/logout', { method:'POST', credentials:'include' }).then(() => location.reload()); }
function printPage() { window.print(); }

// 상세보기 인라인 파일 삭제
async function deleteFileInline(requestId, fileId) {
    const result = await Swal.fire({
        title: '파일을 삭제하시겠습니까?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#DC2626',
        confirmButtonText: '삭제',
        cancelButtonText: '취소'
    });
    if (!result.isConfirmed) return;

    try {
        const { ok, data: json } = await safeFetch(`/api/admin/request/${requestId}/file/${fileId}`, { method: 'DELETE' });
        if (ok && json.success) {
            Swal.fire({ icon: 'success', title: '삭제 완료', timer: 800, showConfirmButton: false, position: 'top-end', toast: true });
            await loadData();
            openDetail(requestId);
        } else {
            Swal.fire('삭제 실패', json.error || '서버 오류가 발생했습니다.', 'error');
        }
    } catch (err) {
        Swal.fire('오류', err.message, 'error');
    }
}

// 상세보기 인라인 파일 추가
async function addFilesInline(requestId, fieldName, inputEl, remaining) {
    if (!inputEl.files || inputEl.files.length === 0) return;
    if (inputEl.files.length > remaining) {
        inputEl.value = '';
        Swal.fire('오류', `${remaining}개까지만 추가할 수 있습니다. (현재 ${5 - remaining}/5)`, 'warning');
        return;
    }
    const fd = new FormData();
    for (const f of inputEl.files) {
        fd.append(fieldName, f);
    }
    inputEl.value = '';

    Swal.fire({ title: '업로드 중\u2026', didOpen: () => Swal.showLoading(), allowOutsideClick: false });

    try {
        const { ok, data: json } = await safeFetch(`/api/admin/request/${requestId}/files`, { method: 'POST', body: fd }, 60000);
        if (ok && json.success) {
            Swal.fire({ icon: 'success', title: `${json.added}개 추가 완료`, timer: 800, showConfirmButton: false, position: 'top-end', toast: true });
            await loadData();
            openDetail(requestId);
        } else {
            Swal.fire('업로드 실패', json.error || '서버 오류가 발생했습니다.', 'error');
        }
    } catch (err) {
        Swal.fire('오류', err.message, 'error');
    }
}

// ── 수정 모드: 상세보기 → 인라인 편집 전환 ──
function toggleEditMode() {
    const d = dataById.get(currentDetailId);
    if (!d) return;
    isEditMode = true;
    modalMode = 'edit';
    $('#btnEdit, #btnDelete, #btnPrint, #btnDownloadWord').hide();
    $('#btnSaveEdit, #btnCancelEdit').removeClass('hidden').show();
    $('#btnSaveCreate').hide();

    // 날짜 형식 변환 (YYYY-MM-DD)
    const toISO = (v) => { if (!v) return ''; const dt = new Date(v); return dt.toISOString().slice(0,10); };

    const inputClass = 'w-full border border-[#D4D4D4] rounded px-3 py-1.5 text-sm font-medium text-[#1A1A1A] outline-none focus:border-[#A3A3A3]';
    const statusOpts = statuses.map(s => `<option value="${s}" ${d.status === s ? 'selected' : ''}>${s}</option>`).join('');

    // Multi-file management section — by category
    const files = d._files || [];
    const isDepositCat = f => f.category === '입출금내역서' || f.category === '입출금거래내역서';
    const editDepositFiles = files.filter(isDepositCat);
    const editIdCardFiles = files.filter(f => !isDepositCat(f));

    function renderEditFileList(fileList) {
        if (fileList.length === 0) return '<p class="text-xs text-[#D4D4D4]">없음</p>';
        return fileList.map(f => {
            const isPdf = f.file_type === 'pdf';
            const icon = isPdf ? '&#128196;' : '&#128444;';
            return `<div class="flex items-center gap-2 py-1.5 border-b border-[#F0F0F0] last:border-0">
                <span class="text-sm">${icon}</span>
                <span class="text-xs text-[#737373] truncate flex-1">${esc(f.original_name)}</span>
                <label class="flex items-center gap-1 cursor-pointer flex-shrink-0">
                    <input type="checkbox" class="edit-delete-file-cb cursor-pointer" data-file-id="${f.id}" style="width:13px;height:13px;">
                    <span class="text-xs font-semibold text-red-500">삭제</span>
                </label>
            </div>`;
        }).join('');
    }

    const fileSection = `
        <div class="mb-3">
            <label class="text-xs font-bold text-[#404040] mb-1 block">입출금내역서 (${editDepositFiles.length}개)</label>
            <div class="border border-[#D4D4D4] rounded px-3 py-2 bg-[#FAFAFA]">
                <div class="mb-2">${renderEditFileList(editDepositFiles)}</div>
                <div>
                    <label class="text-xs text-[#A3A3A3] mb-0.5 block">새 입출금내역서 추가 (최대 5개, PNG/JPG/PDF)</label>
                    <input type="file" id="edit_deposit_files" accept=".jpg,.jpeg,.png,.pdf" multiple class="text-xs text-[#737373]">
                </div>
            </div>
        </div>
        ${d.request_type !== '오입금' ? `<div class="mb-3">
            <label class="text-xs font-bold text-[#404040] mb-1 block">신분증 (${editIdCardFiles.length}개)</label>
            <div class="border border-[#D4D4D4] rounded px-3 py-2 bg-[#FAFAFA]">
                <div class="mb-2">${renderEditFileList(editIdCardFiles)}</div>
                <div>
                    <label class="text-xs text-[#A3A3A3] mb-0.5 block">새 신분증 추가 (최대 5개, PNG/JPG/PDF)</label>
                    <input type="file" id="edit_id_card_files" accept=".jpg,.jpeg,.png,.pdf" multiple class="text-xs text-[#737373]">
                </div>
            </div>
        </div>` : ''}`;

    $('#modalBody').html(`
        <h2 class="text-center text-base sm:text-lg font-black text-[#1A1A1A] tracking-tight pb-3 mb-4 sm:mb-5 border-b-2 border-blue-600">수정 모드</h2>
        <div class="flex justify-between items-start mb-4">
            <div>
                <p class="text-xs text-[#A3A3A3] mb-0.5">식별코드</p>
                <p class="font-mono font-bold text-sm sm:text-base text-[#1A1A1A]">${esc(d.request_code)}</p>
            </div>
            <div class="text-right">
                <p class="text-xs text-[#A3A3A3] mb-0.5">진행 상태</p>
                ${d.status === '완료'
                    ? `<span class="inline-block border border-[#D4D4D4] bg-[#F5F5F5] rounded px-3 py-1.5 text-sm font-bold text-[#737373]">완료</span><input type="hidden" id="edit_status" value="완료">`
                    : `<select id="edit_status" class="border border-[#D4D4D4] rounded px-2 py-1.5 text-sm font-bold outline-none">${statusOpts}</select>`
                }
            </div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            <div><label class="text-xs font-bold text-[#404040] mb-1 block">신청인</label><input id="edit_applicant_name" class="${inputClass}" value="${esc(d.applicant_name)}" maxlength="20"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-1 block">연락처</label><input id="edit_applicant_phone" class="${inputClass}" value="${esc(d.applicant_phone)}" maxlength="11"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-1 block">계약자 코드</label><input id="edit_contractor_code" class="${inputClass}" value="${esc(d.contractor_code)}"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-1 block">가맹점 코드</label><input id="edit_merchant_code" class="${inputClass}" value="${esc(d.merchant_code)}"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-1 block">신청일</label><input id="edit_request_date" type="date" class="${inputClass}" value="${toISO(d.request_date)}"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-1 block">입금일</label><input id="edit_deposit_date" type="date" class="${inputClass}" value="${toISO(d.deposit_date)}"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-1 block">입금시간</label><input id="edit_deposit_time" type="time" step="1" class="${inputClass}" value="${d.deposit_time || ''}"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-1 block">입금액</label><input id="edit_deposit_amount" type="number" class="${inputClass}" value="${d.deposit_amount}"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-1 block">은행명</label><input id="edit_bank_name" class="${inputClass}" value="${esc(d.bank_name)}" maxlength="20"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-1 block">사용계좌</label><input id="edit_user_account" class="${inputClass}" value="${esc(d.user_account)}" maxlength="16"></div>
            <div><label class="text-xs font-bold text-[#404040] mb-1 block">예금주</label><input id="edit_user_account_name" class="${inputClass}" value="${esc(d.user_account_name)}" maxlength="20"></div>
        </div>
        <div class="mb-3">
            <label class="text-xs font-bold text-[#404040] mb-1 block">상세 사유</label>
            <textarea id="edit_details" class="${inputClass}" rows="2" maxlength="200">${esc(d.details)}</textarea>
        </div>
        ${fileSection}
    `);
}

function cancelEditMode() {
    if (modalMode === 'create') {
        closeModal();
    } else {
        isEditMode = false;
        openDetail(currentDetailId);
    }
}

// ── 수정 저장 (필드 + 파일 삭제/추가를 한 번에 전송) ──
async function saveEdit() {
    if (isSaving) return;

    // 클라이언트 필수 필드 검증
    const editFields = {
        '#edit_applicant_name': '신청인 이름',
        '#edit_applicant_phone': '연락처',
        '#edit_contractor_code': '계약자 코드',
        '#edit_merchant_code': '가맹점 코드',
        '#edit_request_date': '신청일자',
        '#edit_deposit_date': '입금일자',
        '#edit_deposit_time': '입금시간',
        '#edit_deposit_amount': '입금액',
        '#edit_bank_name': '은행명',
        '#edit_user_account': '사용계좌',
        '#edit_user_account_name': '예금주'
    };
    const missing = [];
    for (const [sel, label] of Object.entries(editFields)) {
        if (!$(sel).val() || !$(sel).val().toString().trim()) missing.push(label);
    }
    if (missing.length > 0) {
        Swal.fire({ icon: 'warning', title: '필수 항목 누락', html: missing.map(m => `<span class="text-sm">${m}</span>`).join(', ') });
        return;
    }

    isSaving = true;
    const saveBtn = $('#btnSaveEdit');
    saveBtn.prop('disabled', true).text('저장 중\u2026');

    const fd = new FormData();
    fd.append('applicant_name', $('#edit_applicant_name').val());
    fd.append('applicant_phone', $('#edit_applicant_phone').val());
    fd.append('contractor_code', $('#edit_contractor_code').val());
    fd.append('merchant_code', $('#edit_merchant_code').val());
    fd.append('request_date', $('#edit_request_date').val());
    fd.append('deposit_date', $('#edit_deposit_date').val());
    fd.append('deposit_time', $('#edit_deposit_time').val());
    fd.append('deposit_amount', $('#edit_deposit_amount').val());
    fd.append('bank_name', $('#edit_bank_name').val());
    fd.append('user_account', $('#edit_user_account').val());
    fd.append('user_account_name', $('#edit_user_account_name').val());
    fd.append('details', $('#edit_details').val());
    fd.append('status', $('#edit_status').val());

    // Collect file IDs to delete
    const deleteIds = [];
    $('.edit-delete-file-cb:checked').each((_, el) => {
        deleteIds.push($(el).data('file-id'));
    });
    if (deleteIds.length > 0) {
        fd.append('_delete_files', JSON.stringify(deleteIds));
    }

    // New file uploads — by category
    const depositInput = document.getElementById('edit_deposit_files');
    if (depositInput?.files.length > 0) {
        for (const f of depositInput.files) fd.append('deposit_files', f);
    }
    const idCardInput = document.getElementById('edit_id_card_files');
    if (idCardInput?.files.length > 0) {
        for (const f of idCardInput.files) fd.append('id_card_files', f);
    }

    try {
        const { ok, data: json } = await safeFetch(`/api/admin/request/${currentDetailId}`, { method: 'PUT', body: fd }, 60000);
        if (ok && json.success) {
            Swal.fire({ icon: 'success', title: '수정 완료', timer: 1000, showConfirmButton: false });
            await loadData();
            openDetail(currentDetailId);
        } else {
            Swal.fire('수정 실패', json.error || '서버 오류가 발생했습니다.', 'error');
        }
    } catch (err) {
        Swal.fire('오류', err.message, 'error');
    } finally {
        isSaving = false;
        saveBtn.prop('disabled', false).text('저장');
    }
}

// ── 단건 삭제 (확인 후 실행) ──
async function deleteRequest() {
    const d = dataById.get(currentDetailId);
    if (!d) return;
    const result = await Swal.fire({
        title: '정말 삭제하시겠습니까?',
        html: `<p class="text-sm text-gray-500">식별코드: <strong>${esc(d.request_code)}</strong></p><p class="text-sm text-red-500 mt-2">이 작업은 되돌릴 수 없습니다.</p>`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#DC2626',
        confirmButtonText: '삭제',
        cancelButtonText: '취소'
    });
    if (!result.isConfirmed) return;

    try {
        const { ok, data: json } = await safeFetch(`/api/admin/request/${currentDetailId}`, { method: 'DELETE' });
        if (ok && json.success) {
            closeModal();
            allData = allData.filter(d => d.id !== currentDetailId);
            await loadData();
            Swal.fire({ icon: 'success', title: '삭제 완료', timer: 1000, showConfirmButton: false });
        } else {
            Swal.fire('삭제 실패', json.error || '서버 오류가 발생했습니다.', 'error');
        }
    } catch (err) {
        Swal.fire('오류', err.message, 'error');
    }
}

// ── 로그인 폼 ──
$('#loginForm').on('submit', async e => {
    e.preventDefault();
    const loginBtn = $('#loginForm button[type="submit"]');
    loginBtn.prop('disabled', true).text('로그인 중\u2026');
    try {
        const { ok, data: res } = await safeFetch('/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: $('#adminUsername').val(), password: $('#adminPassword').val() })
        });
        if (ok && res.success) location.reload();
        else Swal.fire('실패', res.error || '로그인에 실패했습니다.', 'error');
    } catch (err) {
        Swal.fire('오류', err.message, 'error');
    } finally {
        loginBtn.prop('disabled', false).text('로그인');
    }
});

// ── 엑셀 내보내기 (선택 행 또는 필터된 전체 행) ──
function exportToExcel() {
    let rows = table.rows({ selected: true }).data().toArray();
    // 선택된 행이 없으면 필터된 전체 행 내보내기
    if (rows.length === 0) {
        rows = table.rows({ search: 'applied' }).data().toArray();
        if (rows.length === 0) return Swal.fire({ title: '내보낼 데이터가 없습니다', icon: 'info', timer: 1200, showConfirmButton: false });
    }
    try {
        const data = rows.map(r => {
            const code = $(r[2]).text();
            const item = allData.find(d => d.request_code === code);
            return {
                '신청일': fmtDate(item.request_date),
                '식별코드': code,
                '유형': item.request_type || '반환청구',
                '계약자 코드': item.contractor_code || '',
                '가맹점 코드': item.merchant_code || '',
                '신청인': item.applicant_name,
                '연락처': fmtPhone(item.applicant_phone),
                '입금일': fmtDate(item.deposit_date),
                '입금시간': item.deposit_time || '',
                '입금액': Number(item.deposit_amount),
                '은행': item.bank_name,
                '사용계좌': item.user_account,
                '예금주': item.user_account_name,
                '상세사유': item.details || '',
                '상태': item.status,
                '등록일시': item.created_at ? new Date(item.created_at).toLocaleString('ko-KR') : ''
            };
        });
        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "사유서_데이터");
        const today = new Date();
        const dateSuffix = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
        XLSX.writeFile(wb, `ReasonsForm_Data_${dateSuffix}.xlsx`);
    } catch (err) {
        console.error('Excel export error:', err);
        Swal.fire('오류', '엑셀 파일 생성 중 오류가 발생했습니다.', 'error');
    }
}

// ── Word(DOCX) 다운로드 ──
async function downloadWord() {
    if (!currentDetailId) return;
    try {
        const response = await fetch(`/api/admin/request/${currentDetailId}/docx`, { credentials: 'include' });
        
        // 세션 만료 처리 (safeFetch의 로직과 동일하게)
        if (response.status === 401) {
            await Swal.fire({ icon: 'warning', title: '세션 만료', text: '로그인 세션이 만료되었습니다. 다시 로그인해 주세요.', confirmButtonText: '확인' });
            location.reload();
            return;
        }

        if (!response.ok) {
            let errorMessage = '파일을 생성할 수 없습니다.';
            try {
                const errorJson = await response.json();
                errorMessage = errorJson.error || errorMessage;
            } catch(e) {}
            throw new Error(errorMessage);
        }

        const blob = await response.blob();
        const a = document.createElement('a');
        const d = dataById.get(currentDetailId);
        const filename = `사유서_${d ? d.request_code : currentDetailId}.docx`;

        const reader = new FileReader();
        reader.onload = () => {
            a.href = reader.result;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        };
        reader.readAsDataURL(blob);
    } catch (err) {
        Swal.fire('오류', err.message, 'error');
    }
}

// 이미지 확대
function zoomImage(src) {
    Swal.fire({
        imageUrl: src,
        imageAlt: '상세 이미지',
        showCloseButton: true,
        showConfirmButton: false,
        width: 'auto',
        customClass: { image: 'max-h-[85vh] object-contain' }
    });
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  이벤트 위임 (CSP nonce 호환 — inline onclick 대체)       ║
// ╚═══════════════════════════════════════════════════════════╝

// 모달 바깥 클릭 시 닫기 (오버레이 영역만 반응, 모달 컨텐츠 클릭은 무시)
document.getElementById('detailModal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
});

// data-action 버튼 클릭 → 함수 매핑
document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const actions = {
        logout, exportToExcel, openCreateModal, bulkDelete, resetFilters,
        closeModal, deleteRequest, toggleEditMode, saveEdit, saveCreate,
        cancelEditMode, downloadWord, printPage
    };
    if (actions[action]) actions[action]();
});

// 상태 드롭다운 변경 + 파일 추가 input
document.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-status-change]');
    if (sel) { updateStatusDirect(parseInt(sel.dataset.statusChange), sel); return; }
    const fileInput = e.target.closest('[data-add-files]');
    if (fileInput) { addFilesInline(parseInt(fileInput.dataset.addFiles), fileInput.dataset.field, fileInput, parseInt(fileInput.dataset.remaining)); return; }
});

// 파일 삭제 버튼 + 이미지 클릭 확대
document.addEventListener('click', (e) => {
    const delBtn = e.target.closest('[data-delete-file]');
    if (delBtn) { deleteFileInline(parseInt(delBtn.dataset.deleteFile), parseInt(delBtn.dataset.fileId)); return; }
    const zoomEl = e.target.closest('[data-zoom-image]');
    if (zoomEl) { zoomImage(zoomEl.src ?? zoomEl.querySelector('img')?.src); return; }
});

// 이미지 Enter 키 접근성 (키보드 사용자 지원)
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const zoomEl = e.target.closest('[data-zoom-image]');
        if (zoomEl) zoomImage(zoomEl.src ?? zoomEl.querySelector('img')?.src);
    }
});
