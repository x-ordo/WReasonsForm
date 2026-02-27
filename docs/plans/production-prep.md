# Objective
보안 강화, 성능 최적화, 모니터링 체계를 구축하여 안정적인 프로덕션 배포 상태로 전환한다.

# Key Files & Context
*   `src/server.js`: CSP 보안 정책 강화, 로그 설정, 프록시 설정.
*   `public/*.html`: Tailwind CDN 제거 및 정적 CSS 참조로 변경.
*   `package.json`: 빌드 스크립트 추가 및 의존성 확인.
*   `.env.example`: 운영 환경에 필요한 필수 환경변수 명시.

# Implementation Steps
1.  **Tailwind CSS 정적 빌드**: CDN 의존성을 제거하고 Tailwind CLI를 통해 최적화된 CSS 파일을 생성합니다.
2.  **보안 강화**: `server.js`의 CSP 설정을 더 엄격하게(`unsafe-inline` 제거) 수정합니다.
3.  **로그 기록기 도입**: `morgan` 파일 스트림을 사용하여 `logs/` 디렉토리에 로그를 저장하도록 설정합니다.
4.  **환경 설정 정비**: 운영 환경용 `.env` 가이드를 업데이트하고, 관리자 비밀번호 변경 가이드를 작성합니다.
5.  **PM2 설정 확인**: `ecosystem.config.js`가 클러스터 모드 및 자동 재시작을 지원하도록 최종 점검합니다.

# Verification & Testing
*   CSS 정적 파일 생성 및 HTML 참조 확인.
*   CSP 적용 후 브라우저 콘솔에서 리소스 차단 오류 발생 여부 확인.
*   파일 업로드 및 텔레그램 알림 정상 동작 확인.
*   로그 파일 생성 및 기록 여부 확인.
