# ReasonsForm 배포 가이드

Windows Server + MSSQL (SQL Server) + PM2 환경 배포 문서

---

## 목차

1. [사전 요구사항](#1-사전-요구사항)
2. [SQL Server 설정](#2-sql-server-설정)
3. [Node.js 설치](#3-nodejs-설치)
4. [프로젝트 배포](#4-프로젝트-배포)
5. [환경 변수 설정](#5-환경-변수-설정)
6. [데이터베이스 스키마 적용](#6-데이터베이스-스키마-적용)
7. [PM2 설치 및 실행](#7-pm2-설치-및-실행)
8. [PM2 Windows 서비스 등록](#8-pm2-windows-서비스-등록)
9. [방화벽 설정](#9-방화벽-설정)
10. [업데이트 배포](#10-업데이트-배포)
11. [트러블슈팅](#11-트러블슈팅)

---

## 1. 사전 요구사항

| 항목 | 최소 사양 |
|------|-----------|
| OS | Windows Server 2016 이상 |
| MSSQL | SQL Server 2016 이상 (Express 가능) |
| Node.js | v18 LTS 이상 (v20 권장) |
| 디스크 | 앱 + 업로드 파일 저장 공간 확보 |
| 네트워크 | 포트 4000 (앱), 1433 (MSSQL) 접근 가능 |

---

## 2. SQL Server 설정

### 2.1 SQL Server 인증 모드

SQL Server Management Studio (SSMS) 에서:

1. 서버 속성 → **보안** → **SQL Server 및 Windows 인증 모드** 선택
2. SQL Server 서비스 재시작

### 2.2 데이터베이스 생성

```sql
CREATE DATABASE REASONS_DB
COLLATE Korean_Wansung_CI_AS;
```

### 2.3 로그인 계정 생성

```sql
USE REASONS_DB;

CREATE LOGIN reasons_user WITH PASSWORD = '강력한_비밀번호';
CREATE USER reasons_user FOR LOGIN reasons_user;
ALTER ROLE db_owner ADD MEMBER reasons_user;
```

> `db_owner` 역할은 스키마 마이그레이션(`dbPush.js`)에서 테이블 생성/변경에 필요합니다. 운영 안정화 후 `db_datareader`, `db_datawriter` + DDL 권한으로 축소할 수 있습니다.

### 2.4 TCP/IP 활성화

SQL Server Configuration Manager에서:

1. **SQL Server 네트워크 구성** → **프로토콜** → **TCP/IP** 사용
2. TCP/IP 속성 → **IP Addresses** → **IPAll** → **TCP Port**: `1433`
3. SQL Server 서비스 재시작

---

## 3. Node.js 설치

1. https://nodejs.org 에서 LTS 버전 다운로드 (`.msi`)
2. 설치 시 **"Add to PATH"** 체크 확인
3. 설치 확인:

```powershell
node --version   # v20.x.x
npm --version    # 10.x.x
```

---

## 4. 프로젝트 배포

### 4.1 소스 코드 배치

프로젝트 파일을 서버에 복사합니다. 예시 경로: `C:\apps\ReasonMaker`

```powershell
# Git이 설치되어 있다면:
git clone <저장소URL> C:\apps\ReasonMaker

# 또는 zip 파일로 전달 후 압축 해제
```

### 4.2 의존성 설치

```powershell
cd C:\apps\ReasonMaker
npm install --production
```

### 4.3 업로드 디렉토리 생성

```powershell
mkdir C:\apps\ReasonMaker\uploads
mkdir C:\apps\ReasonMaker\logs
```

- `uploads/` — 사유서 첨부파일 저장 (UUID 파일명, JPG/PNG/PDF)
- `logs/` — PM2 로그 파일 저장

---

## 5. 환경 변수 설정

`.env.example`을 복사하여 `.env` 파일을 생성합니다:

```powershell
copy .env.example .env
```

`.env` 파일을 편집합니다:

```env
# 서버 포트
PORT=4000

# MSSQL 접속 정보
DB_SERVER=localhost
DB_USER=reasons_user
DB_PASSWORD=강력한_비밀번호
DB_NAME=REASONS_DB
DB_PORT=1433
DB_TRUST_SERVER_CERTIFICATE=true

# 세션 시크릿 (반드시 랜덤 값으로 변경)
SESSION_SECRET=여기에_랜덤_문자열

# Telegram 알림 (선택)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

### 세션 시크릿 생성

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

출력된 64자 hex 문자열을 `SESSION_SECRET`에 넣습니다.

> **주의**: `.env` 파일은 절대 Git에 커밋하지 마세요.

---

## 6. 데이터베이스 스키마 적용

```powershell
cd C:\apps\ReasonMaker
node src/dbPush.js
```

정상 실행 시 출력:

```
--- Starting Database Push ---
Executing schema.sql...
Connected to MSSQL Database
✅ Database schema applied successfully!
```

이 스크립트는 멱등(idempotent)합니다. `IF NOT EXISTS` 조건으로 테이블이 이미 있으면 건너뜁니다. 마이그레이션 ALTER 문도 조건 검사 후 실행되므로 **반복 실행해도 안전**합니다.

### 생성되는 테이블

| 테이블 | 설명 |
|--------|------|
| `Users` | 관리자 계정 (기본 admin 계정 자동 생성) |
| `Requests` | 사유서 접수 데이터 |
| `RequestFiles` | 첨부파일 메타데이터 (FK → Requests) |
| `Sessions` | Express 세션 저장소 |

### 테스트 데이터 삽입 (선택)

```powershell
node src/seed.js
```

---

## 7. PM2 설치 및 실행

### 7.1 PM2 전역 설치

```powershell
npm install -g pm2
```

### 7.2 앱 시작

```powershell
cd C:\apps\ReasonMaker
pm2 start ecosystem.config.js
```

`ecosystem.config.js` 설정 내용:

| 항목 | 값 |
|------|-----|
| 프로세스명 | `reasonsform` |
| 인스턴스 | 1 |
| 메모리 제한 | 300MB (초과 시 자동 재시작) |
| 로그 경로 | `./logs/out.log`, `./logs/error.log` |
| 자동 재시작 | 활성화 |

### 7.3 PM2 관리 명령어

```powershell
# 상태 확인
npm run pm2:status       # 또는 pm2 status

# 로그 확인
npm run pm2:logs         # 또는 pm2 logs reasonsform

# 재시작
npm run pm2:restart      # 또는 pm2 restart reasonsform

# 중지
npm run pm2:stop         # 또는 pm2 stop reasonsform

# 프로세스 삭제
pm2 delete reasonsform
```

---

## 8. PM2 Windows 서비스 등록

서버 재부팅 시 PM2가 자동 시작되도록 Windows 서비스로 등록합니다.

### 8.1 pm2-installer 사용

```powershell
npm install -g pm2-windows-startup
pm2-startup install
```

### 8.2 현재 프로세스 목록 저장

```powershell
pm2 save
```

> 이후 서버를 재부팅해도 `reasonsform` 프로세스가 자동으로 시작됩니다.

### 8.3 대안: NSSM 사용

`pm2-windows-startup`이 동작하지 않으면 [NSSM](https://nssm.cc)을 사용합니다:

```powershell
# NSSM 다운로드 후
nssm install PM2 "C:\Users\<사용자>\AppData\Roaming\npm\pm2.cmd" resurrect
nssm set PM2 AppDirectory C:\apps\ReasonMaker
nssm start PM2
```

---

## 9. 방화벽 설정

### 앱 포트 개방

```powershell
netsh advfirewall firewall add rule name="ReasonMaker" dir=in action=allow protocol=tcp localport=4000
```

### 리버스 프록시 구성 (권장)

프로덕션 환경에서는 IIS 또는 nginx를 리버스 프록시로 사용하여 80/443 포트로 서비스하는 것을 권장합니다:

**IIS ARR (Application Request Routing) 예시:**

1. IIS에 ARR + URL Rewrite 모듈 설치
2. 사이트 추가 → 바인딩: 80 (또는 443 + SSL 인증서)
3. URL Rewrite 규칙 추가:
   - 패턴: `(.*)`
   - 재작성 URL: `http://localhost:4000/{R:1}`

---

## 10. 업데이트 배포

```powershell
cd C:\apps\ReasonMaker

# 1. 소스 업데이트
git pull origin main          # 또는 파일 덮어쓰기

# 2. 의존성 업데이트 (package.json 변경 시)
npm install --production

# 3. DB 스키마 마이그레이션 (schema.sql 변경 시)
node src/dbPush.js

# 4. 앱 재시작
pm2 restart reasonsform

# 5. 로그로 정상 기동 확인
pm2 logs reasonsform --lines 20
```

> `uploads/` 디렉토리는 소스와 별개이므로 업데이트 시 삭제되지 않도록 주의합니다.

---

## 11. 트러블슈팅

### DB 연결 실패

```
Database Connection Failed! Bad Config: ConnectionError: Failed to connect
```

- `.env`의 `DB_SERVER`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` 확인
- SQL Server TCP/IP 프로토콜 활성화 여부 확인
- SQL Server Browser 서비스 실행 중인지 확인
- 방화벽에서 1433 포트 개방 확인

### TLS ServerName 경고

```
(node:xxxx) [DEP0123] DeprecationWarning: Setting the TLS ServerName to an IP address is not permitted
```

이 경고는 `DB_SERVER`에 IP 주소를 사용할 때 발생합니다. 기능에는 영향 없으며, 제거하려면 `DB_SERVER`를 호스트명(예: `localhost`)으로 변경합니다.

### 파일 업로드 실패

- `uploads/` 디렉토리가 존재하고 Node.js 프로세스에 쓰기 권한이 있는지 확인
- 파일 크기 10MB, 파일 형식 JPG/PNG/PDF만 허용
- 카테고리당 최대 5개, 총 최대 10개 파일

### 한글 파일명 깨짐

브라우저를 통한 업로드는 정상 동작합니다. curl이나 API 클라이언트에서 테스트할 경우 UTF-8 인코딩으로 전송해야 합니다.

### PM2 로그 확인

```powershell
# 실시간 로그
pm2 logs reasonsform

# 에러 로그만
type logs\error.log

# 로그 초기화
pm2 flush reasonsform
```

### 관리자 계정

초기 관리자 계정은 `dbPush.js` 실행 시 자동 생성됩니다:
- ID: `admin`
- 비밀번호: schema.sql에 정의된 초기값

> **중요**: 배포 후 반드시 관리자 비밀번호를 변경하세요.

---

## 디렉토리 구조

```
C:\apps\ReasonMaker\
├── .env                    # 환경 변수 (Git 미포함)
├── ecosystem.config.js     # PM2 설정
├── package.json
├── src/
│   ├── server.js           # Express 앱 (메인)
│   ├── db.js               # MSSQL 커넥션 풀
│   ├── dbPush.js           # 스키마 마이그레이션
│   ├── schema.sql          # DB 스키마 정의
│   └── seed.js             # 테스트 데이터
├── public/
│   ├── index.html          # 공개 폼 (사유서 제출 + 상태 조회)
│   └── admin.html          # 관리자 대시보드
├── uploads/                # 첨부파일 저장 (UUID 파일명)
└── logs/                   # PM2 로그
    ├── out.log
    └── error.log
```
