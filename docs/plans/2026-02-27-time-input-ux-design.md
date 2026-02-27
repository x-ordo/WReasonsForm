# 입금 시간 입력 UX 업그레이드

## 결정: 날짜+시간 모달 + 3-Segment + 빠른 선택 버튼

### 현재 → 변경

**현재**: 날짜 input + 시간 input (native type="time") 세로 배치
**변경**: 날짜 영역에 버튼 → 클릭 시 SweetAlert2 모달 오픈 → 날짜 + 시간(3-segment + 빠른선택 버튼)

### 모달 구성

1. **날짜**: `<input type="date">` (기존과 동일, max=today)
2. **빠른 선택 버튼**: 09:00~18:00 정시 + [현재시각] 버튼
3. **3-Segment 시간 입력**: 시[00-23] : 분[00-59] : 초[00-59]
   - `inputmode="numeric"`, maxlength=2
   - 2자리 입력 시 다음 필드 auto-advance
   - blur 시 zero-pad ("5" → "05")
   - 범위 초과 시 clamp
4. **확인/취소 버튼**

### 버튼 동작 (메인 폼)

- 선택 전: "날짜·시간 선택" 텍스트 + 아이콘
- 선택 후: "2026-02-27 14:30:45" 포맷으로 표시
- hidden inputs: `deposit_date`, `deposit_time`

### 적용 범위

- `public/index.html`: 두 폼의 date+time 영역 → 버튼으로 교체
- `public/js/index.js`: 모달 열기, 3-segment 로직, hidden field 동기화
- `public/css/tailwind.css`: 재빌드 (새 클래스 필요 시)
- admin.js: 이번 범위에서 제외 (별도 태스크)

### 정밀도

HH:MM:SS (초 단위까지 필수)
