-- ============================================================
-- ReasonsForm 데이터베이스 스키마 (MSSQL)
-- 모든 테이블·컬럼에 MS_Description 확장 속성 포함
-- ============================================================

-- ============================================================
-- 1. Users 테이블 (관리자 계정)
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Users')
BEGIN
    CREATE TABLE Users (
        id              INT IDENTITY(1,1) PRIMARY KEY,
        username        NVARCHAR(30) UNIQUE NOT NULL,       -- 로그인 ID
        password_hash   NVARCHAR(72) NOT NULL,              -- BCrypt 해시 (60자 고정 + 여유)
        name            NVARCHAR(20) NOT NULL,              -- 표시 이름
        role            NVARCHAR(10) DEFAULT 'admin',       -- 권한 역할
        last_login      DATETIME NULL,
        created_at      DATETIME DEFAULT GETDATE()
    );

    -- 기본 관리자 (Password: tkdbtj2026!@)
    INSERT INTO Users (username, password_hash, name)
    VALUES ('admin', '$2b$10$8iAuwIa1S4azwk1nrsu1P.RBnIT0Ed0rqgVmShnkYBr.FP9zdWQAy', N'시스템관리자');
END

-- ============================================================
-- 2. Requests 테이블 (사유서 접수 데이터)
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Requests')
BEGIN
    CREATE TABLE Requests (
        id                  INT IDENTITY(1,1) PRIMARY KEY,
        request_code        NVARCHAR(20)  UNIQUE NOT NULL,  -- YYMMDD-NNN-XXX (14자)
        request_date        DATE          NOT NULL,
        deposit_date        DATE          NOT NULL,
        deposit_amount      DECIMAL(15,0) NOT NULL,         -- 최대 999,999,999,999,999원
        bank_name           NVARCHAR(20)  NOT NULL,
        user_account        NVARCHAR(16)  NOT NULL,         -- 계좌번호 숫자만
        user_account_name   NVARCHAR(20)  NOT NULL,         -- 예금주
        contractor_code     NVARCHAR(50)  NOT NULL,         -- 구분코드1
        merchant_code       NVARCHAR(50)  NOT NULL,         -- 구분코드2
        applicant_name      NVARCHAR(20)  NOT NULL,         -- 신청인 성명 (최대 20자)
        applicant_phone     NVARCHAR(11)  NOT NULL,         -- 숫자만 (01012345678)
        details             NVARCHAR(200) NULL,
        id_card_file        NVARCHAR(50)  NULL,             -- UUID.확장자 (최대 41자)
        terms_agreed        BIT DEFAULT 0,                  -- 개인정보 동의 여부
        terms_ip            NVARCHAR(45)  NULL,             -- 동의 시 IP (IPv6 대응)
        status              NVARCHAR(10)  DEFAULT N'대기'
            CHECK (status IN (N'대기', N'접수', N'처리중', N'완료', N'반려')),
        created_at          DATETIME DEFAULT GETDATE()
    );

    CREATE INDEX idx_request_code ON Requests(request_code);
    CREATE INDEX idx_status ON Requests(status);
    CREATE INDEX idx_applicant_name ON Requests(applicant_name);
END

-- ============================================================
-- 3. Sessions 테이블 (인증 세션 관리)
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Sessions')
BEGIN
    CREATE TABLE Sessions (
        sid         NVARCHAR(255)  PRIMARY KEY,
        session     NVARCHAR(MAX)  NOT NULL,
        expires     DATETIME       NOT NULL
    );
END

-- ============================================================
-- 4. Migration: 기존 DB 컬럼 변경 (멱등성 보장)
-- ============================================================

-- 4-1. terms 컬럼 추가
IF COL_LENGTH('Requests', 'terms_agreed') IS NULL
    ALTER TABLE Requests ADD terms_agreed BIT DEFAULT 0;

IF COL_LENGTH('Requests', 'terms_ip') IS NULL
    ALTER TABLE Requests ADD terms_ip NVARCHAR(45) NULL;

-- 4-2. applicant_name → 20자 확장
IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Requests' AND COLUMN_NAME='applicant_name' AND CHARACTER_MAXIMUM_LENGTH < 20)
    ALTER TABLE Requests ALTER COLUMN applicant_name NVARCHAR(20) NOT NULL;

-- 4-3. 과대 컬럼 축소 (실제 데이터 범위에 맞춤)
-- Users
IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Users' AND COLUMN_NAME='username' AND CHARACTER_MAXIMUM_LENGTH > 30)
    ALTER TABLE Users ALTER COLUMN username NVARCHAR(30) NOT NULL;

IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Users' AND COLUMN_NAME='password_hash' AND CHARACTER_MAXIMUM_LENGTH > 72)
    ALTER TABLE Users ALTER COLUMN password_hash NVARCHAR(72) NOT NULL;

IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Users' AND COLUMN_NAME='name' AND CHARACTER_MAXIMUM_LENGTH > 20)
    ALTER TABLE Users ALTER COLUMN name NVARCHAR(20) NOT NULL;

-- Requests
IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Requests' AND COLUMN_NAME='request_code' AND CHARACTER_MAXIMUM_LENGTH > 20)
    ALTER TABLE Requests ALTER COLUMN request_code NVARCHAR(20) NOT NULL;

IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Requests' AND COLUMN_NAME='id_card_file' AND CHARACTER_MAXIMUM_LENGTH > 50)
    ALTER TABLE Requests ALTER COLUMN id_card_file NVARCHAR(50);

-- ============================================================
-- 5. SSMS 설명 (MS_Description 확장 속성)
--    패턴: DROP 시도 → 실패 무시 → ADD (멱등성)
-- ============================================================

-- ─── Users 테이블 ───
BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Users'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'시스템 관리자 계정. 로그인 인증 및 세션 관리에 사용.', N'SCHEMA',N'dbo', N'TABLE',N'Users';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Users', N'COLUMN',N'id'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'자동 증가 기본키', N'SCHEMA',N'dbo', N'TABLE',N'Users', N'COLUMN',N'id';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Users', N'COLUMN',N'username'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'로그인 아이디 (영문·숫자, UNIQUE, 최대 30자)', N'SCHEMA',N'dbo', N'TABLE',N'Users', N'COLUMN',N'username';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Users', N'COLUMN',N'password_hash'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'BCrypt 해시 비밀번호 ($2b$ 접두어, 고정 60자)', N'SCHEMA',N'dbo', N'TABLE',N'Users', N'COLUMN',N'password_hash';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Users', N'COLUMN',N'name'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'관리자 표시 이름 (한글, 최대 20자)', N'SCHEMA',N'dbo', N'TABLE',N'Users', N'COLUMN',N'name';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Users', N'COLUMN',N'role'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'권한 역할 (기본값: admin)', N'SCHEMA',N'dbo', N'TABLE',N'Users', N'COLUMN',N'role';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Users', N'COLUMN',N'last_login'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'마지막 로그인 일시 (로그인 성공 시 GETDATE()로 갱신)', N'SCHEMA',N'dbo', N'TABLE',N'Users', N'COLUMN',N'last_login';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Users', N'COLUMN',N'created_at'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'계정 생성 일시', N'SCHEMA',N'dbo', N'TABLE',N'Users', N'COLUMN',N'created_at';

-- ─── Requests 테이블 ───
BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'사유서(반환 청구서) 접수 데이터. 공개 폼에서 제출되며, 관리자가 상태를 관리한다.', N'SCHEMA',N'dbo', N'TABLE',N'Requests';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'id'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'자동 증가 기본키', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'id';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'request_code'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'접수 식별코드. 형식: YYMMDD-NNN-XXX (날짜-순번-랜덤3자). 공개 조회 키로 사용.', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'request_code';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'request_date'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'사유서 신청일 (신청인이 폼에서 선택)', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'request_date';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'deposit_date'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'실제 입금일 (오입금이 발생한 날짜)', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'deposit_date';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'deposit_amount'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'입금액 (원 단위, 소수점 없음). DECIMAL(15,0)으로 최대 999조원 처리.', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'deposit_amount';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'bank_name'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'반환받을 은행명 (예: 신한은행, 최대 20자)', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'bank_name';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'user_account'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'반환받을 계좌번호 (숫자만 저장, 하이픈 제거, 최대 16자리)', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'user_account';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'user_account_name'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'반환 계좌 예금주 (최대 20자)', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'user_account_name';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'contractor_code'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'계약자 구분코드 (구분코드1). 프론트에서 contractor_type으로 전송.', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'contractor_code';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'merchant_code'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'가맹점 구분코드 (구분코드2). 프론트에서 merchant_type으로 전송.', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'merchant_code';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'applicant_name'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'신청인 성명 (최대 20자, 공개 조회 시 첫 글자 + ** 마스킹)', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'applicant_name';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'applicant_phone'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'신청인 연락처 (숫자만 저장, 하이픈 제거, 10~11자리)', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'applicant_phone';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'details'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'상세 청구 사유 (최대 200자, NULL 허용)', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'details';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'id_card_file'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'첨부 신분증 파일명. UUID.확장자 형식 (예: a1b2c3d4-...-e5f6.jpg). uploads/ 디렉토리에 저장.', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'id_card_file';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'terms_agreed'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'개인정보 수집·이용 동의 여부 (0=미동의, 1=동의)', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'terms_agreed';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'terms_ip'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'동의 시점 클라이언트 IP (IPv4 또는 IPv6, 최대 45자). req.ip에서 캡처.', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'terms_ip';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'status'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'처리 상태. 워크플로: 대기→접수→처리중→완료 또는 반려. CHECK 제약으로 5개 값만 허용.', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'status';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'created_at'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'DB 등록 일시 (서버 시간 기준 자동 기록)', N'SCHEMA',N'dbo', N'TABLE',N'Requests', N'COLUMN',N'created_at';

-- ─── Sessions 테이블 ───
BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Sessions'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'Express 세션 저장소 (connect-mssql-v2). 관리자 인증 세션 유지에 사용.', N'SCHEMA',N'dbo', N'TABLE',N'Sessions';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Sessions', N'COLUMN',N'sid'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'세션 고유 ID (connect-mssql-v2가 생성)', N'SCHEMA',N'dbo', N'TABLE',N'Sessions', N'COLUMN',N'sid';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Sessions', N'COLUMN',N'session'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'세션 데이터 (JSON 직렬화, user 객체 포함)', N'SCHEMA',N'dbo', N'TABLE',N'Sessions', N'COLUMN',N'session';

BEGIN TRY EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA',N'dbo', N'TABLE',N'Sessions', N'COLUMN',N'expires'; END TRY BEGIN CATCH END CATCH;
EXEC sp_addextendedproperty N'MS_Description', N'세션 만료 일시 (maxAge: 8시간)', N'SCHEMA',N'dbo', N'TABLE',N'Sessions', N'COLUMN',N'expires';
