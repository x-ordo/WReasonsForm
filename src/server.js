/**
 * server.js — 사유서 작성 시스템 메인 서버
 *
 * Express v5 모놀리스: 라우팅, 미들웨어, 비즈니스 로직이 모두 이 파일에 포함.
 *
 * 주요 구성:
 *   1. 의존성 로드 및 보안 상수
 *   2. 유틸리티 헬퍼 (에러 분류, 파일 암호화, 로깅, 식별코드 생성)
 *   3. Express 앱 설정 (보안 헤더, 세션, 정적 파일)
 *   4. 파일 업로드 파이프라인 (multer → 한글 복원 → 매직바이트 검증 → 암호화)
 *   5. 인증 API (로그인, 로그아웃, 세션 확인)
 *   6. 공개 API (폼 제출, 상태 조회)
 *   7. 관리자 API (CRUD, 파일 관리, DOCX 생성)
 *   8. 정기 작업 (텔레그램 알림, 고아 파일 정리)
 */
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const MSSQLStore = require('connect-mssql-v2');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const { poolPromise, mssql } = require('./db');
const { v4: uuidv4 } = require('uuid');
const FileType = require('file-type');
const cron = require('node-cron');
const { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, Table, TableRow, TableCell, WidthType } = require('docx');
require('dotenv').config();

// 타이밍 사이드채널 방어용 더미 해시 (존재하지 않는 유저 요청 시 bcrypt 연산 균등화)
const DUMMY_HASH = bcrypt.hashSync('__dummy_never_match__', 10);

// ── 에러 분류 헬퍼 ──
function classifyError(err, context) {
    // MSSQL 에러 번호별 한글 매핑
    if (err?.number) {
        switch (err.number) {
            case 2627: case 2601: return '중복된 데이터가 존재합니다.';
            case 547: return '데이터 무결성 제약 조건에 위배됩니다.';
            case 8152: return '입력 값이 허용 길이를 초과합니다.';
            case 245: case 8114: return '입력 값의 형식이 올바르지 않습니다.';
        }
    }
    // MSSQL 연결 에러
    if (err?.code === 'ESOCKET' || err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEOUT') {
        return '데이터베이스 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.';
    }
    console.error(`[${context}]`, err);
    return '서버 처리 중 오류가 발생했습니다. 문제가 계속되면 관리자에게 문의해 주세요.';
}

// ── 파일 at-rest 암호화 (AES-256-GCM) ──
if (!process.env.FILE_ENCRYPTION_KEY) {
    console.error('FATAL: FILE_ENCRYPTION_KEY is not set in .env — generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
}
const ENC_KEY_BUF = Buffer.from(process.env.FILE_ENCRYPTION_KEY, 'hex');

function encryptFile(filePath) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY_BUF, iv);
    const input = fs.readFileSync(filePath);
    const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Format: [16 bytes IV][16 bytes authTag][encrypted data]
    fs.writeFileSync(filePath, Buffer.concat([iv, authTag, encrypted]));
}

function decryptFile(filePath) {
    const data = fs.readFileSync(filePath);
    const iv = data.subarray(0, 16);
    const authTag = data.subarray(16, 32);
    const encrypted = data.subarray(32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY_BUF, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

// ── 보안 이벤트 구조화 로깅 ──
function logSecurity(event, details) {
    const entry = {
        timestamp: new Date().toISOString(),
        event,
        ...details
    };
    console.log(JSON.stringify(entry));
}

// ── 필드명 한글 매핑 ──
const FIELD_LABELS = {
    applicant_name: '신청인 이름',
    applicant_phone: '연락처',
    request_date: '신청일자',
    deposit_date: '입금일자',
    deposit_amount: '입금액',
    bank_name: '은행명',
    refund_account: '환불계좌',
    refund_account_name: '예금주',
    contractor_type: '계약자 코드',
    merchant_type: '가맹점 코드'
};

// ── 식별코드 생성 (MAX 기반 + UNIQUE 제약 재시도) ──
async function generateRequestCode(poolOrTx, requestType = '반환청구') {
    const typePrefix = requestType === '오입금' ? 'M' : 'R';
    const date = new Date();
    const datePrefix = `${date.getFullYear().toString().slice(-2)}${(date.getMonth()+1).toString().padStart(2,'0')}${date.getDate().toString().padStart(2,'0')}`;
    const fullPrefix = `${typePrefix}-${datePrefix}`;

    const seqResult = await poolOrTx.request()
        .input('prefix', mssql.NVarChar, `${fullPrefix}-%`)
        .query("SELECT ISNULL(MAX(CAST(SUBSTRING(request_code, 10, 3) AS INT)), 0) + 1 AS next_seq FROM Requests WHERE request_code LIKE @prefix");
    let nextSeq = seqResult.recordset[0].next_seq;

    for (let attempt = 0; attempt < 5; attempt++) {
        const rand = crypto.randomBytes(2).toString('hex').toUpperCase().slice(0, 3);
        const requestCode = `${fullPrefix}-${String(nextSeq).padStart(3, '0')}-${rand}`;
        try {
            // 유효성만 확인 — 실제 INSERT 시 UNIQUE 제약이 동시성 가드 역할
            const dup = await poolOrTx.request()
                .input('code', mssql.NVarChar, requestCode)
                .query('SELECT 1 FROM Requests WHERE request_code = @code');
            if (dup.recordset.length === 0) return requestCode;
            nextSeq++;
        } catch (err) {
            if (attempt < 4) { nextSeq++; continue; }
            throw err;
        }
    }
    throw new Error('식별코드 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.');
}

// ── 텔레그램 알림 ──

// HTML 이스케이핑: 사용자 입력을 텔레그램 메시지에 안전하게 삽입
function escTg(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 여러 채팅방에 텔레그램 메시지 발송 (fire-and-forget, 실패해도 서버 동작에 영향 없음)
async function sendTelegramNotification(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatIds = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
    const threadId = process.env.TELEGRAM_THREAD_ID;
    if (!token || chatIds.length === 0) return;

    // Send to all configured chat IDs (User, Group, or Channel)
    for (const chatId of chatIds) {
        try {
            const payload = { chat_id: chatId, text: message, parse_mode: 'HTML' };
            if (threadId) payload.message_thread_id = threadId;

            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } catch (err) { console.error(`Telegram notification failed for chat ${chatId}:`, err.message); }
    }
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  Express 앱 초기화 및 보안 설정                           ║
// ╚═══════════════════════════════════════════════════════════╝

const app = express();
const PORT = process.env.PORT || 3000;

// 요청마다 고유 CSP nonce 생성 (helmet보다 먼저 등록해야 함)
app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
});

// 보안 헤더 (CSP: nonce 기반 스크립트 허용, CDN 화이트리스트)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'",
                (req, res) => `'nonce-${res.locals.cspNonce}'`,
                "https://code.jquery.com/jquery-3.7.1.min.js",
                "https://cdn.datatables.net/1.13.7/js/jquery.dataTables.min.js",
                "https://cdn.datatables.net/select/1.7.0/js/dataTables.select.min.js",
                "https://cdn.jsdelivr.net/npm/sweetalert2@11.14.5/dist/sweetalert2.all.min.js",
                "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
                "https://cdn.tailwindcss.com"
            ],
            scriptSrcAttr: ["'none'"],
            styleSrc: ["'self'",
                "'unsafe-inline'", // Still needed for some library injected styles (e.g. DataTables/SweetAlert)
                "https://cdn.jsdelivr.net",
                "https://cdn.datatables.net",
                "https://cdnjs.cloudflare.com"
            ],
            imgSrc: ["'self'", "data:", "blob:"],
            fontSrc: ["'self'"],
            connectSrc: ["'self'", "https://cdn.jsdelivr.net"],
            objectSrc: ["'none'"],
            frameAncestors: ["'self'"],
            upgradeInsecureRequests: null,
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
    strictTransportSecurity: false,
}));

// HTML 페이지 제공: %%CSP_NONCE%% 플레이스홀더를 실제 nonce로 치환 (express.static보다 먼저)
app.get('/', (req, res) => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    res.send(html.replace(/%%CSP_NONCE%%/g, res.locals.cspNonce));
});
app.get('/admin.html', (req, res) => {
    const html = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
    res.send(html.replace(/%%CSP_NONCE%%/g, res.locals.cspNonce));
});

app.use(express.static(path.join(__dirname, '../public')));
app.use('/public', express.static(path.join(__dirname, '../public')));

// ── 공통 미들웨어 ──
app.use(cors({
    origin: process.env.CORS_ORIGIN || `http://localhost:${process.env.PORT || 3000}`,
    credentials: true
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── 세션 설정 (MSSQL 기반 영구 저장) ──
const sessionConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT) || 1433,
    options: {
        encrypt: true,
        trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === 'true'
    }
};

if (!process.env.SESSION_SECRET) {
    console.error('FATAL: SESSION_SECRET 환경변수가 설정되지 않았습니다. .env 파일을 확인하세요.');
    process.exit(1);
}

app.use(session({
    store: new MSSQLStore(sessionConfig, { table: 'Sessions' }), // Explicitly map to Sessions table
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'reasonsform.sid', // Custom cookie name
    cookie: {
        secure: false,
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 8
    }
}));

// ── 파일 다운로드 (관리자 전용) ──
// at-rest 암호화된 파일을 복호화하여 제공, 미암호화 레거시 파일도 지원
app.use('/uploads', (req, res) => {
    if (!req.session?.user) {
        return res.status(403).json({ success: false, code: 'FORBIDDEN', error: 'Forbidden' });
    }
    const filename = path.basename(req.path);
    const filePath = path.resolve(uploadDir, filename);
    if (!filePath.startsWith(path.resolve(uploadDir))) {
        return res.status(403).json({ success: false, code: 'FORBIDDEN', error: 'Forbidden' });
    }
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'File not found' });
    }
    try {
        const ext = path.extname(filename).toLowerCase();
        const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf' };
        res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment');
        // 암호화된 파일 복호화 시도, 실패 시 미암호화 파일로 fallback
        let content;
        try {
            content = decryptFile(filePath);
        } catch (_) {
            content = fs.readFileSync(filePath);
        }
        res.send(content);
    } catch (err) {
        console.error('File read error:', err.message);
        return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: '파일을 읽을 수 없습니다.' });
    }
});

// ── 인증 미들웨어 (관리자 API 보호) ──
const authMiddleware = (req, res, next) => {
    if (req.session?.user) return next();
    return res.status(401).json({ success: false, error: 'Unauthorized access' });
};

// ╔═══════════════════════════════════════════════════════════╗
// ║  파일 업로드 파이프라인                                    ║
// ║  multer → 한글 파일명 복원 → 매직바이트 검증 → AES 암호화 ║
// ╚═══════════════════════════════════════════════════════════╝

// 업로드 디렉토리 보장
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// 한글 파일명 복원: busboy가 latin1로 디코딩한 것을 UTF-8로 재변환
function fixOriginalName(file) {
    try {
        // 이미 정상 UTF-8이면 변환하지 않음 (이중 변환 방지)
        // busboy가 latin1으로 잘못 디코딩한 경우 0x80~0xFF 범위의 문자가 포함됨
        if (!/[\x80-\xff]/.test(file.originalname)) return; // 순수 ASCII → 변환 불필요
        const fixed = Buffer.from(file.originalname, 'latin1').toString('utf8');
        // 변환 결과가 유효한 문자열인지 확인 (replacement character 없으면 성공)
        if (!fixed.includes('\ufffd')) {
            file.originalname = fixed;
        }
    } catch (e) { /* 변환 실패 시 원본 유지 */ }
}
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        fixOriginalName(file);
        cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024, files: 10 }, // 10MB per file, max 10 files (5 per category)
    fileFilter: (req, file, cb) => {
        // fileFilter 시점에도 한글 복원 (busboy latin1 디코딩 대응)
        fixOriginalName(file);
        // 위험 문자 차단: null byte, 경로 탐색, 제어 문자
        if (/[\x00-\x1f]|\.\.\/|\.\.\\/.test(file.originalname)) {
            const err = new Error("파일명에 허용되지 않는 문자가 포함되어 있습니다.");
            err.code = 'INVALID_FILE_TYPE';
            return cb(err);
        }
        const filetypes = /jpeg|jpg|png|pdf/;
        const mimetype = /jpeg|jpg|png|pdf/.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) return cb(null, true);
        const err = new Error("이미지 또는 PDF 파일만 업로드 가능합니다. (JPG, PNG, PDF / 최대 10MB)");
        err.code = 'INVALID_FILE_TYPE';
        cb(err);
    }
});

// multer v2 후처리: 내부적으로 originalname이 재설정될 수 있어 최종 보정
function fixUploadedFileNames(req, res, next) {
    if (req.file) fixOriginalName(req.file);
    if (req.files) {
        if (Array.isArray(req.files)) {
            req.files.forEach(fixOriginalName);
        } else {
            for (const fieldFiles of Object.values(req.files)) {
                fieldFiles.forEach(fixOriginalName);
            }
        }
    }
    next();
}

// 매직바이트 검증 미들웨어: 업로드된 파일의 실제 내용이 허용 형식인지 확인
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'application/pdf']);
async function validateFileMagic(req, res, next) {
    const files = [];
    if (req.file) files.push(req.file);
    if (req.files) {
        if (Array.isArray(req.files)) files.push(...req.files);
        else for (const fieldFiles of Object.values(req.files)) files.push(...fieldFiles);
    }
    for (const file of files) {
        try {
            const type = await FileType.fromFile(file.path);
            if (!type || !ALLOWED_MIMES.has(type.mime)) {
                logSecurity('FILE_VALIDATION_FAILED', { filename: file.originalname, detectedMime: type ? type.mime : 'unknown' });
                cleanupUpload(req);
                return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: `'${file.originalname}' 파일의 실제 형식이 허용되지 않습니다. JPG, PNG, PDF 파일만 업로드 가능합니다.` });
            }
        } catch (e) {
            logSecurity('FILE_VALIDATION_ERROR', { filename: file.originalname, error: e.message });
            cleanupUpload(req);
            return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: '업로드된 파일을 검증할 수 없습니다.' });
        }
    }
    // 매직바이트 검증 통과 후 at-rest 암호화 적용
    for (const file of files) {
        try {
            encryptFile(file.path);
        } catch (e) {
            logSecurity('FILE_ENCRYPTION_ERROR', { filename: file.originalname, error: e.message });
            cleanupUpload(req);
            return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: '파일 처리 중 오류가 발생했습니다.' });
        }
    }
    next();
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  인증 API (로그인 · 로그아웃 · 세션 확인)                 ║
// ╚═══════════════════════════════════════════════════════════╝

// 계정 잠금: brute-force 방어 (메모리 기반, 서버 재시작 시 초기화)
const loginAttempts = new Map(); // { username: { count, lockedUntil } }
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15분

// ── Rate Limiter 정의 ──
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, error: '로그인 시도가 너무 많습니다. 15분 후 다시 시도해 주세요.' },
    standardHeaders: true,
    legacyHeaders: false
});

// Rate limiting: 공개 폼 제출 15분당 20회
const submitLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { success: false, error: '제출 횟수를 초과했습니다. 잠시 후 다시 시도해 주세요.' },
    standardHeaders: true,
    legacyHeaders: false
});

// ── POST /api/admin/login — 관리자 로그인 ──
// 계정 잠금 확인 → DB 조회 → bcrypt 비교 → 세션 재생성 → 응답
app.post('/api/admin/login', loginLimiter, async (req, res) => {
    const username = (req.body.username || '').trim();
    const password = (req.body.password || '').trim();
    if (!username || !password) {
        return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: '아이디와 비밀번호를 입력해 주세요.' });
    }

    const normalizedUser = username.toLowerCase();

    // 계정 잠금 확인
    const attempt = loginAttempts.get(normalizedUser);
    if (attempt && attempt.lockedUntil && Date.now() < attempt.lockedUntil) {
        const remainMin = Math.ceil((attempt.lockedUntil - Date.now()) / 60000);
        return res.status(429).json({ success: false, code: 'RATE_LIMIT', error: `계정이 잠겨 있습니다. ${remainMin}분 후 다시 시도해 주세요.` });
    }

    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('username', mssql.NVarChar, username)
            .query('SELECT * FROM Users WHERE username = @username');

        if (result.recordset.length > 0) {
            const user = result.recordset[0];
            const isMatch = await bcrypt.compare(password, user.password_hash);

            if (isMatch) {
                loginAttempts.delete(normalizedUser);
                logSecurity('LOGIN_SUCCESS', { username: normalizedUser, ip: req.ip });
                await pool.request().input('id', mssql.Int, user.id).query('UPDATE Users SET last_login = GETDATE() WHERE id = @id');

                // 세션 고정 공격 방지: 인증 성공 시 세션 ID 재생성
                return req.session.regenerate((regenErr) => {
                    if (regenErr) {
                        console.error('Session Regenerate Error:', regenErr);
                        return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: '세션 생성 중 오류가 발생했습니다.' });
                    }
                    req.session.user = { id: user.id, username: user.username, name: user.name };
                    return req.session.save((err) => {
                        if (err) {
                            console.error('Session Save Error:', err);
                            return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: '세션 저장 중 오류가 발생했습니다.' });
                        }
                        return res.json({ success: true, user: req.session.user });
                    });
                });
            }
        } else {
            await bcrypt.compare(password, DUMMY_HASH);
        }

        // 실패 기록
        const prev = loginAttempts.get(normalizedUser) || { count: 0, lockedUntil: null };
        prev.count += 1;
        if (prev.count >= MAX_LOGIN_ATTEMPTS) {
            prev.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
            logSecurity('ACCOUNT_LOCKED', { username: normalizedUser, ip: req.ip, duration: '15m' });
            sendTelegramNotification(`🚨 <b>계정 잠금</b>\n계정: <code>${escTg(normalizedUser)}</code>\nIP: <code>${escTg(req.ip)}</code>\n사유: 로그인 ${MAX_LOGIN_ATTEMPTS}회 실패`).catch(() => {});
        }
        loginAttempts.set(normalizedUser, prev);
        logSecurity('LOGIN_FAILED', { username: normalizedUser, ip: req.ip, attempts: prev.count });

        return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    } catch (err) {
        const classified = classifyError(err, 'POST /api/admin/login');
        return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: classified });
    }
});

// ── GET /api/admin/me — 현재 세션 확인 ──
app.get('/api/admin/me', (req, res) => {
    if (req.session.user) return res.json({ success: true, user: req.session.user });
    else return res.status(401).json({ success: false });
});

// ── POST /api/admin/logout — 로그아웃 (세션 파기 + 쿠키 삭제) ──
app.post('/api/admin/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) console.error('Session destroy error:', err);
        res.clearCookie('reasonsform.sid', { httpOnly: true, sameSite: 'lax', path: '/' });
        return res.json({ success: true });
    });
});

// ── 업로드 헬퍼 함수들 ──

// 검증 실패·에러 시 multer가 디스크에 저장한 파일을 정리
function cleanupUpload(req) {
    const files = req.file
        ? [req.file]
        : req.files
            ? (Array.isArray(req.files) ? req.files : Object.values(req.files).flat())
            : [];
    for (const f of files) {
        const filePath = path.resolve(uploadDir, f.filename);
        if (filePath.startsWith(path.resolve(uploadDir))) {
            fs.unlink(filePath, (err) => {
                if (err && err.code !== 'ENOENT') console.error('cleanupUpload unlink error:', err.message);
            });
        }
    }
}

// upload.fields() 결과를 flat 배열로 변환
function getAllUploadedFiles(req) {
    if (!req.files) return [];
    return Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
}

// RequestFiles 테이블에 파일 레코드 삽입 (7곳에서 공통 사용)
async function insertFileRecord(poolOrTx, requestId, file, category) {
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    await poolOrTx.request()
        .input('requestId', mssql.Int, requestId)
        .input('filename', mssql.NVarChar, file.filename)
        .input('originalName', mssql.NVarChar, file.originalname)
        .input('fileType', mssql.NVarChar, ext)
        .input('category', mssql.NVarChar, category)
        .query('INSERT INTO RequestFiles (request_id, filename, original_name, file_type, category) VALUES (@requestId, @filename, @originalName, @fileType, @category)');
}

// ── 업로드 디렉토리 총 사이즈 체크 (쿼터: 5GB) ──
const UPLOAD_QUOTA_BYTES = 5 * 1024 * 1024 * 1024; // 5GB
function getUploadDirSize() {
    try {
        const files = fs.readdirSync(uploadDir);
        return files.reduce((total, file) => {
            try { return total + fs.statSync(path.join(uploadDir, file)).size; } catch { return total; }
        }, 0);
    } catch { return 0; }
}

const checkUploadQuota = (req, res, next) => {
    if (getUploadDirSize() > UPLOAD_QUOTA_BYTES) {
        cleanupUpload(req);
        return res.status(507).json({ success: false, code: 'SERVER_ERROR', error: '서버 저장 공간이 부족합니다. 관리자에게 문의해 주세요.' });
    }
    next();
};

// ╔═══════════════════════════════════════════════════════════╗
// ║  공개 API (인증 불필요)                                    ║
// ╚═══════════════════════════════════════════════════════════╝

// ── POST /api/request — 공개 폼 제출 (반환청구 / 오입금) ──
// 트랜잭션: 식별코드 생성 → Requests INSERT → RequestFiles INSERT → 텔레그램 알림
app.post('/api/request', submitLimiter, upload.fields([{ name: 'deposit_files', maxCount: 5 }, { name: 'id_card_files', maxCount: 5 }]), fixUploadedFileNames, validateFileMagic, checkUploadQuota, async (req, res) => {
    try {
        // 서버 입력값 검증
        const d = req.body;
        const requestType = d.request_type || '반환청구';
        if (!['반환청구', '오입금'].includes(requestType)) {
            cleanupUpload(req);
            return res.status(400).json({ success: false, error: '유효하지 않은 신청 유형입니다.' });
        }
        const required = ['applicant_name', 'applicant_phone', 'deposit_date', 'deposit_amount', 'bank_name', 'refund_account', 'contractor_type', 'merchant_type'];
        for (const field of required) {
            if (!d[field] || !d[field].trim()) {
                cleanupUpload(req);
                const label = FIELD_LABELS[field] || field;
                return res.status(400).json({ success: false, error: `필수 항목이 누락되었습니다: ${label}` });
            }
        }
        if (d.applicant_name.length > 20) { cleanupUpload(req); return res.status(400).json({ success: false, error: '신청인 이름은 20자 이내여야 합니다.' }); }
        if (d.applicant_phone.replace(/\D/g, '').length < 10) { cleanupUpload(req); return res.status(400).json({ success: false, error: '올바른 전화번호를 입력해 주세요.' }); }
        if (requestType === '반환청구') {
            const amountNum = Number(d.deposit_amount.replace(/\D/g, ''));
            if (amountNum < 2000000) { cleanupUpload(req); return res.status(400).json({ success: false, error: '반환 청구는 200만원 이상만 신청 가능합니다.' }); }
        }
        if (!['true', '1', 'on'].includes(d.terms_agreed)) { cleanupUpload(req); return res.status(400).json({ success: false, error: '개인정보 활용 동의는 필수입니다.' }); }
        const depositFiles = req.files?.deposit_files ?? [];
        const idCardFiles = req.files?.id_card_files ?? [];
        if (depositFiles.length === 0) { cleanupUpload(req); return res.status(400).json({ success: false, error: '입출금거래내역서 파일은 최소 1개 필수입니다.' }); }
        if (requestType === '반환청구' && idCardFiles.length === 0) { cleanupUpload(req); return res.status(400).json({ success: false, error: '신분증 파일은 최소 1개 필수입니다.' }); }

        const pool = await poolPromise;
        const transaction = new mssql.Transaction(pool);
        await transaction.begin();
        try {
            const requestCode = await generateRequestCode(transaction, requestType);

            const allFiles = [...depositFiles, ...idCardFiles];
            const firstFile = allFiles.length > 0 ? allFiles[0].filename : null;

            const insertResult = await transaction.request()
                .input('requestCode', mssql.NVarChar, requestCode)
                .input('depositDate', mssql.Date, d.deposit_date)
                .input('depositAmount', mssql.Decimal, d.deposit_amount.replace(/\D/g, ''))
                .input('bankName', mssql.NVarChar, d.bank_name)
                .input('userAccount', mssql.NVarChar, d.refund_account.replace(/\D/g, ''))
                .input('userAccountName', mssql.NVarChar, d.applicant_name)
                .input('contractorCode', mssql.NVarChar, d.contractor_type)
                .input('merchantCode', mssql.NVarChar, d.merchant_type)
                .input('applicantName', mssql.NVarChar, d.applicant_name)
                .input('applicantPhone', mssql.NVarChar, d.applicant_phone.replace(/\D/g, ''))
                .input('details', mssql.NVarChar, d.details)
                .input('idCardFile', mssql.NVarChar, firstFile)
                .input('termsAgreed', mssql.Bit, ['true', '1', 'on'].includes(d.terms_agreed) ? 1 : 0)
                .input('termsIp', mssql.NVarChar, (req.ip || '').replace(/^::ffff:/, '') || null)
                .input('requestType', mssql.NVarChar, requestType)
                .query(`INSERT INTO Requests (request_code, request_date, deposit_date, deposit_amount, bank_name, user_account, user_account_name, contractor_code, merchant_code, applicant_name, applicant_phone, details, id_card_file, terms_agreed, terms_ip, request_type)
                        OUTPUT INSERTED.id
                        VALUES (@requestCode, CAST(GETDATE() AS DATE), @depositDate, @depositAmount, @bankName, @userAccount, @userAccountName, @contractorCode, @merchantCode, @applicantName, @applicantPhone, @details, @idCardFile, @termsAgreed, @termsIp, @requestType)`);

            const requestId = insertResult.recordset[0].id;

            for (const f of depositFiles) await insertFileRecord(transaction, requestId, f, '입출금거래내역서');
            for (const f of idCardFiles) await insertFileRecord(transaction, requestId, f, '신분증');

            await transaction.commit();

            // Fire-and-forget Telegram notification (before return, inside try)
            const kstTime = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
            const amountFmt = Number(d.deposit_amount.replace(/\D/g, '')).toLocaleString('ko-KR');
            const maskedName = d.applicant_name ? d.applicant_name.charAt(0) + '**' : '***';
            const typeLabel = requestType === '오입금' ? '오입금 포인트' : '반환 청구';
            sendTelegramNotification(
                `<b>새 ${typeLabel} 접수</b>\n식별코드: <code>${requestCode}</code>\n신청인: ${maskedName}\n파일: ${allFiles.length}개\n접수시간: ${kstTime}`
            ).catch(() => {});

            return res.json({ success: true, requestCode });
        } catch (txErr) {
            try { await transaction.rollback(); } catch (rbErr) { console.error('Transaction rollback failed:', rbErr); }
            cleanupUpload(req);
            throw txErr;
        }
    } catch (err) {
        cleanupUpload(req);
        return res.status(500).json({ success: false, error: classifyError(err, 'POST /api/request') });
    }
});

// ── GET /api/status/:code — 공개 상태 조회 (이름 마스킹) ──
const statusLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: { success: false, error: '조회 횟수를 초과했습니다. 잠시 후 다시 시도해 주세요.' },
    standardHeaders: true,
    legacyHeaders: false
});

const REQUEST_CODE_RE = /^([RM]-)?\d{6}-\d{3}-[A-Z0-9]{3}$/;  // R-YYMMDD-NNN-XXX 또는 M-YYMMDD-NNN-XXX
app.get('/api/status/:code', statusLimiter, async (req, res) => {
    if (!REQUEST_CODE_RE.test(req.params.code)) {
        return res.status(400).json({ success: false, error: '식별코드 형식이 올바르지 않습니다. (예: R-260222-001-ABC)' });
    }
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('code', mssql.NVarChar, req.params.code)
            .query('SELECT applicant_name, status, created_at, request_type FROM Requests WHERE request_code = @code');
        if (result.recordset.length > 0) {
            const row = result.recordset[0];
            const name = row.applicant_name || '';
            return res.json({ success: true, data: { ...row, applicant_name: name.length > 0 ? name[0] + '**' : '***' } });
        } else return res.status(404).json({ success: false, error: '해당 식별코드로 접수된 사유서를 찾을 수 없습니다.' });
    } catch (err) { return res.status(500).json({ success: false, error: classifyError(err, 'GET /api/status') }); }
});

// ╔═══════════════════════════════════════════════════════════╗
// ║  관리자 API (authMiddleware 보호)                         ║
// ╚═══════════════════════════════════════════════════════════╝

// ── GET /api/admin/requests — 전체 목록 조회 (파일 수 포함) ──
app.get('/api/admin/requests', authMiddleware, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT r.*, ISNULL(fc.cnt, 0) AS file_count
            FROM Requests r
            LEFT JOIN (SELECT request_id, COUNT(*) AS cnt FROM RequestFiles GROUP BY request_id) fc
              ON fc.request_id = r.id
            ORDER BY r.created_at DESC
        `);
        return res.json({ success: true, data: result.recordset });
    } catch (err) { return res.status(500).json({ success: false, error: classifyError(err, 'GET /api/admin/requests') }); }
});

// ── GET /api/admin/request/:id — 단건 상세 조회 (첨부파일 포함) ──
app.get('/api/admin/request/:id', authMiddleware, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().input('id', mssql.Int, req.params.id).query('SELECT * FROM Requests WHERE id = @id');
        const files = await pool.request().input('id2', mssql.Int, req.params.id)
            .query('SELECT * FROM RequestFiles WHERE request_id = @id2 ORDER BY uploaded_at');
        const data = result.recordset[0];
        if (!data) return res.status(404).json({ success: false, error: '상세 정보를 찾을 수 없습니다.' });
        data.files = files.recordset;
        return res.json({ success: true, data });
    } catch (err) { return res.status(500).json({ success: false, error: classifyError(err, 'GET /api/admin/request/:id') }); }
});

// ── GET /api/admin/request/:id/docx — Word 문서 생성·다운로드 ──
app.get('/api/admin/request/:id/docx', authMiddleware, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().input('id', mssql.Int, req.params.id).query('SELECT * FROM Requests WHERE id = @id');
        const data = result.recordset[0];
        if (!data) return res.status(404).json({ success: false, error: '상세 정보를 찾을 수 없습니다.' });

        const doc = new Document({
            sections: [{
                properties: {},
                children: [
                    new Paragraph({
                        text: "반환 청구 사유서",
                        heading: HeadingLevel.HEADING_1,
                        alignment: AlignmentType.CENTER,
                        spacing: { after: 400 },
                    }),
                    new Table({
                        width: { size: 100, type: WidthType.PERCENTAGE },
                        rows: [
                            new TableRow({
                                children: [
                                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "식별코드", bold: true })] })], width: { size: 20, type: WidthType.PERCENTAGE }, shading: { fill: "F5F5F5" } }),
                                    new TableCell({ children: [new Paragraph(data.request_code)], width: { size: 30, type: WidthType.PERCENTAGE } }),
                                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "진행상태", bold: true })] })], width: { size: 20, type: WidthType.PERCENTAGE }, shading: { fill: "F5F5F5" } }),
                                    new TableCell({ children: [new Paragraph(data.status)], width: { size: 30, type: WidthType.PERCENTAGE } }),
                                ],
                            }),
                            new TableRow({
                                children: [
                                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "신청인", bold: true })] })], shading: { fill: "F5F5F5" } }),
                                    new TableCell({ children: [new Paragraph(data.applicant_name)] }),
                                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "연락처", bold: true })] })], shading: { fill: "F5F5F5" } }),
                                    new TableCell({ children: [new Paragraph(data.applicant_phone)] }),
                                ],
                            }),
                            new TableRow({
                                children: [
                                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "지사코드", bold: true })] })], shading: { fill: "F5F5F5" } }),
                                    new TableCell({ children: [new Paragraph(data.contractor_code || "-")] }),
                                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "가맹점코드", bold: true })] })], shading: { fill: "F5F5F5" } }),
                                    new TableCell({ children: [new Paragraph(data.merchant_code || "-")] }),
                                ],
                            }),
                            new TableRow({
                                children: [
                                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "신청일", bold: true })] })], shading: { fill: "F5F5F5" } }),
                                    new TableCell({ children: [new Paragraph(new Date(data.request_date).toLocaleDateString('ko-KR'))] }),
                                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "입금일", bold: true })] })], shading: { fill: "F5F5F5" } }),
                                    new TableCell({ children: [new Paragraph(new Date(data.deposit_date).toLocaleDateString('ko-KR'))] }),
                                ],
                            }),
                            new TableRow({
                                children: [
                                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "입금액", bold: true })] })], shading: { fill: "F5F5F5" } }),
                                    new TableCell({ children: [new Paragraph(Number(data.deposit_amount).toLocaleString() + "원")], columnSpan: 3 }),
                                ],
                            }),
                            new TableRow({
                                children: [
                                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "사용계좌", bold: true })] })], shading: { fill: "F5F5F5" } }),
                                    new TableCell({ children: [new Paragraph(`${data.bank_name} / ${data.user_account} / ${data.user_account_name}`)], columnSpan: 3 }),
                                ],
                            }),
                        ],
                    }),
                    new Paragraph({ text: "", spacing: { before: 400 } }),
                    new Paragraph({
                        children: [new TextRun({ text: "상세 청구 사유", bold: true })],
                        spacing: { after: 100 },
                    }),
                    new Table({
                        width: { size: 100, type: WidthType.PERCENTAGE },
                        rows: [
                            new TableRow({
                                children: [
                                    new TableCell({
                                        children: data.details ? data.details.split('\n').map(line => new Paragraph({ text: line, spacing: { before: 100, after: 100 } })) : [new Paragraph("내용 없음")],
                                        margins: { top: 200, bottom: 200, left: 200, right: 200 }
                                    }),
                                ],
                            }),
                        ],
                    }),
                    new Paragraph({ text: "", spacing: { before: 800 } }),
                    new Paragraph({
                        text: `제출일시: ${new Date().toLocaleString('ko-KR')}`,
                        alignment: AlignmentType.RIGHT,
                        spacing: { after: 200 },
                    }),
                ],
            }],
        });

        const buffer = await Packer.toBuffer(doc);
        const filename = encodeURIComponent(`사유서_${data.request_code}.docx`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
        return res.send(buffer);
    } catch (err) { return res.status(500).json({ success: false, error: classifyError(err, 'GET /api/admin/request/:id/docx') }); }
});

// ── POST /api/admin/request/:id/files — 기존 요청에 파일 추가 ──
// Express v5: 구체적 경로(/:id/files)를 덜 구체적 경로(/:id) 앞에 등록
app.post('/api/admin/request/:id/files', authMiddleware, upload.fields([{ name: 'deposit_files', maxCount: 5 }, { name: 'id_card_files', maxCount: 5 }]), fixUploadedFileNames, validateFileMagic, checkUploadQuota, async (req, res) => {
    try {
        const requestId = parseInt(req.params.id, 10);
        if (isNaN(requestId)) { cleanupUpload(req); return res.status(400).json({ success: false, error: '잘못된 요청 ID입니다.' }); }
        const pool = await poolPromise;

        // 존재 확인
        const exists = await pool.request().input('id', mssql.Int, requestId).query('SELECT id FROM Requests WHERE id = @id');
        if (exists.recordset.length === 0) { cleanupUpload(req); return res.status(404).json({ success: false, error: '요청을 찾을 수 없습니다.' }); }

        // 카테고리별 현재 파일 수 확인
        const counts = await pool.request().input('reqId', mssql.Int, requestId)
            .query("SELECT category, COUNT(*) AS cnt FROM RequestFiles WHERE request_id = @reqId GROUP BY category");
        const countMap = Object.fromEntries(counts.recordset.map(r => [r.category, r.cnt]));

        const addDepositFiles = req.files?.deposit_files ?? [];
        const addIdCardFiles = req.files?.id_card_files ?? [];

        if ((countMap['입출금거래내역서'] ?? 0) + addDepositFiles.length > 5) {
            cleanupUpload(req);
            return res.status(400).json({ success: false, error: '입출금거래내역서는 최대 5개까지 첨부할 수 있습니다.' });
        }
        if ((countMap['신분증'] ?? 0) + addIdCardFiles.length > 5) {
            cleanupUpload(req);
            return res.status(400).json({ success: false, error: '신분증은 최대 5개까지 첨부할 수 있습니다.' });
        }

        for (const f of addDepositFiles) await insertFileRecord(pool, requestId, f, '입출금거래내역서');
        for (const f of addIdCardFiles) await insertFileRecord(pool, requestId, f, '신분증');

        // Sync id_card_file
        const remaining = await pool.request().input('syncId', mssql.Int, requestId)
            .query('SELECT TOP 1 filename FROM RequestFiles WHERE request_id = @syncId ORDER BY uploaded_at');
        const firstFile = remaining.recordset[0]?.filename ?? null;
        await pool.request()
            .input('syncReqId', mssql.Int, requestId)
            .input('idCardFile', mssql.NVarChar, firstFile)
            .query('UPDATE Requests SET id_card_file = @idCardFile WHERE id = @syncReqId');

        return res.json({ success: true, added: addDepositFiles.length + addIdCardFiles.length });
    } catch (err) {
        cleanupUpload(req);
        return res.status(500).json({ success: false, error: classifyError(err, 'POST /api/admin/request/:id/files') });
    }
});

// ── POST /api/admin/request — 관리자 신규 등록 ──
app.post('/api/admin/request', authMiddleware, upload.fields([{ name: 'deposit_files', maxCount: 5 }, { name: 'id_card_files', maxCount: 5 }]), fixUploadedFileNames, validateFileMagic, checkUploadQuota, async (req, res) => {
    try {
        const d = req.body;
        const requestType = d.request_type || '반환청구';
        if (!['반환청구', '오입금'].includes(requestType)) {
            cleanupUpload(req);
            return res.status(400).json({ success: false, error: '유효하지 않은 신청 유형입니다.' });
        }
        const required = ['applicant_name', 'applicant_phone', 'request_date', 'deposit_date', 'deposit_amount', 'bank_name', 'refund_account', 'refund_account_name', 'contractor_type', 'merchant_type'];
        for (const field of required) {
            if (!d[field] || !d[field].trim()) {
                cleanupUpload(req);
                const label = FIELD_LABELS[field] || field;
                return res.status(400).json({ success: false, error: `필수 항목이 누락되었습니다: ${label}` });
            }
        }
        if (d.applicant_name.length > 20) { cleanupUpload(req); return res.status(400).json({ success: false, error: '신청인 이름은 20자 이내여야 합니다.' }); }
        if (d.applicant_phone.replace(/\D/g, '').length < 10) { cleanupUpload(req); return res.status(400).json({ success: false, error: '올바른 전화번호를 입력해 주세요.' }); }
        if (new Date(d.deposit_date) > new Date(d.request_date)) { cleanupUpload(req); return res.status(400).json({ success: false, error: '입금일자는 신청일자와 같거나 이전이어야 합니다.' }); }

        const pool = await poolPromise;
        const transaction = new mssql.Transaction(pool);
        await transaction.begin();
        try {
            const requestCode = await generateRequestCode(transaction, requestType);

            const adminDepositFiles = req.files?.deposit_files ?? [];
            const adminIdCardFiles = req.files?.id_card_files ?? [];
            const allAdminFiles = [...adminDepositFiles, ...adminIdCardFiles];
            const firstFile = allAdminFiles.length > 0 ? allAdminFiles[0].filename : null;

            const insertResult = await transaction.request()
                .input('requestCode', mssql.NVarChar, requestCode)
                .input('requestDate', mssql.Date, d.request_date)
                .input('depositDate', mssql.Date, d.deposit_date)
                .input('depositAmount', mssql.Decimal, d.deposit_amount.replace(/\D/g, ''))
                .input('bankName', mssql.NVarChar, d.bank_name)
                .input('userAccount', mssql.NVarChar, d.refund_account.replace(/\D/g, ''))
                .input('userAccountName', mssql.NVarChar, d.refund_account_name)
                .input('contractorCode', mssql.NVarChar, d.contractor_type)
                .input('merchantCode', mssql.NVarChar, d.merchant_type)
                .input('applicantName', mssql.NVarChar, d.applicant_name)
                .input('applicantPhone', mssql.NVarChar, d.applicant_phone.replace(/\D/g, ''))
                .input('details', mssql.NVarChar, d.details || null)
                .input('idCardFile', mssql.NVarChar, firstFile)
                .input('termsAgreed', mssql.Bit, ['true', '1', 'on'].includes(d.terms_agreed) ? 1 : 0)
                .input('termsIp', mssql.NVarChar, null)
                .input('requestType', mssql.NVarChar, requestType)
                .query(`INSERT INTO Requests (request_code, request_date, deposit_date, deposit_amount, bank_name, user_account, user_account_name, contractor_code, merchant_code, applicant_name, applicant_phone, details, id_card_file, terms_agreed, terms_ip, request_type)
                        OUTPUT INSERTED.id
                        VALUES (@requestCode, @requestDate, @depositDate, @depositAmount, @bankName, @userAccount, @userAccountName, @contractorCode, @merchantCode, @applicantName, @applicantPhone, @details, @idCardFile, @termsAgreed, @termsIp, @requestType)`);

            const requestId = insertResult.recordset[0].id;
            for (const f of adminDepositFiles) await insertFileRecord(transaction, requestId, f, '입출금거래내역서');
            for (const f of adminIdCardFiles) await insertFileRecord(transaction, requestId, f, '신분증');

            await transaction.commit();
            return res.json({ success: true, requestCode });
        } catch (txErr) {
            try { await transaction.rollback(); } catch (rbErr) { console.error('Transaction rollback failed:', rbErr); }
            cleanupUpload(req);
            throw txErr;
        }
    } catch (err) {
        cleanupUpload(req);
        return res.status(500).json({ success: false, error: classifyError(err, 'POST /api/admin/request') });
    }
});

// ── PUT /api/admin/status — 상태 변경 (워크플로 검증) ──
// 대기 ↔ 접수 ↔ 처리중 ↔ 반려 자유 이동, '완료'는 최종 상태 (변경 불가)
app.put('/api/admin/status', authMiddleware, async (req, res) => {
    try {
        const { id, status } = req.body;

        // 허용 상태값 검증
        const ALLOWED_STATUSES = ['대기', '접수', '처리중', '완료', '반려'];
        if (!ALLOWED_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, error: '유효하지 않은 상태값입니다.' });
        }
        if (!id || isNaN(parseInt(id, 10))) {
            return res.status(400).json({ success: false, error: '유효하지 않은 요청 ID입니다.' });
        }

        // 워크플로 전환 검증
        // - '대기', '접수', '처리중', '반려'는 서로 자유롭게 이동 가능
        // - 어떤 상태에서든 '완료'로 이동 가능
        // - '완료' 상태가 되면 더 이상 변경 불가
        const pool = await poolPromise;
        const current = await pool.request().input('id', mssql.Int, id).query('SELECT status FROM Requests WHERE id = @id');
        if (current.recordset.length === 0) {
            return res.status(404).json({ success: false, error: '해당 사유서를 찾을 수 없습니다.' });
        }

        const currentStatus = current.recordset[0].status;
        
        if (currentStatus === '완료') {
            return res.status(400).json({ success: false, error: "'완료' 상태의 데이터는 수정할 수 없습니다." });
        }

        if (currentStatus === status) return res.json({ success: true }); // 상태 변화 없음

        await pool.request().input('id', mssql.Int, id).input('status', mssql.NVarChar, status).query('UPDATE Requests SET status = @status WHERE id = @id');
        return res.json({ success: true });
    } catch (err) { return res.status(500).json({ success: false, error: classifyError(err, 'PUT /api/admin/status') }); }
});

// ── PUT /api/admin/request/:id — 요청 수정 (필드 + 파일 삭제/추가) ──
// multipart/form-data 지원: 텍스트 필드 수정 + 파일 삭제(_delete_files) + 새 파일 업로드
app.put('/api/admin/request/:id', authMiddleware, upload.fields([{ name: 'deposit_files', maxCount: 5 }, { name: 'id_card_files', maxCount: 5 }]), fixUploadedFileNames, validateFileMagic, checkUploadQuota, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ success: false, error: '잘못된 요청 ID입니다.' });
        const d = req.body;
        const pool = await poolPromise;

        const allowedFields = {
            request_date: mssql.Date,
            deposit_date: mssql.Date,
            deposit_amount: mssql.Decimal,
            bank_name: mssql.NVarChar,
            user_account: mssql.NVarChar,
            user_account_name: mssql.NVarChar,
            contractor_code: mssql.NVarChar,
            merchant_code: mssql.NVarChar,
            applicant_name: mssql.NVarChar,
            applicant_phone: mssql.NVarChar,
            details: mssql.NVarChar,
            status: mssql.NVarChar
        };

        // 입금일자 ≤ 신청일자 검증 (하나만 전송되어도 DB 기존 값과 비교)
        if (d.deposit_date || d.request_date) {
            const existing = await pool.request().input('chkId', mssql.Int, id)
                .query('SELECT request_date, deposit_date FROM Requests WHERE id = @chkId');
            if (existing.recordset.length > 0) {
                const reqDate = d.request_date || existing.recordset[0].request_date;
                const depDate = d.deposit_date || existing.recordset[0].deposit_date;
                if (reqDate && depDate && new Date(depDate) > new Date(reqDate)) {
                    cleanupUpload(req);
                    return res.status(400).json({ success: false, error: '입금일자는 신청일자와 같거나 이전이어야 합니다.' });
                }
            }
        }

        const setClauses = [];
        const transaction = new mssql.Transaction(pool);
        await transaction.begin();

        try {
            const request = transaction.request().input('id', mssql.Int, id);

            for (const [field, type] of Object.entries(allowedFields)) {
                if (d[field] !== undefined) {
                    let value = d[field];
                    if (field === 'deposit_amount') value = String(value).replace(/\D/g, '');
                    if (field === 'applicant_phone') value = String(value).replace(/\D/g, '');
                    request.input(field, type, value);
                    setClauses.push(`${field} = @${field}`);
                }
            }

            // Handle individual file deletions (_delete_files = JSON array of file IDs)
            if (d._delete_files) {
                try {
                    const deleteIds = JSON.parse(d._delete_files);
                    if (!Array.isArray(deleteIds) || deleteIds.length > 20) {
                        await transaction.rollback();
                        return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: '삭제할 파일 정보가 올바르지 않습니다.' });
                    }
                    for (const fileId of deleteIds) {
                        if (!Number.isInteger(fileId) || fileId < 1) continue;
                        const fileResult = await transaction.request()
                            .input('fileId', mssql.Int, fileId)
                            .input('reqId', mssql.Int, id)
                            .query('SELECT filename FROM RequestFiles WHERE id = @fileId AND request_id = @reqId');
                        if (fileResult.recordset.length > 0) {
                            const fname = fileResult.recordset[0].filename;
                            const resolved = path.resolve(uploadDir, fname);
                            if (resolved.startsWith(path.resolve(uploadDir))) {
                                fs.unlink(resolved, (err) => { if (err && err.code !== 'ENOENT') console.error('unlink error:', err.message); });
                            }
                            await transaction.request()
                                .input('delId', mssql.Int, fileId)
                                .query('DELETE FROM RequestFiles WHERE id = @delId');
                        }
                    }
                } catch (e) {
                    try { await transaction.rollback(); } catch (rbErr) { /* already rolled back */ }
                    cleanupUpload(req);
                    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: '삭제할 파일 정보가 올바르지 않습니다.' });
                }
            }

            // Handle new file uploads with category (카테고리별 5개 제한 검증)
            const newDepositFiles = req.files?.deposit_files ?? [];
            const newIdCardFiles = req.files?.id_card_files ?? [];
            if (newDepositFiles.length > 0 || newIdCardFiles.length > 0) {
                const fileCounts = await transaction.request().input('fReqId', mssql.Int, id)
                    .query("SELECT category, COUNT(*) AS cnt FROM RequestFiles WHERE request_id = @fReqId GROUP BY category");
                const countMap = Object.fromEntries(fileCounts.recordset.map(r => [r.category, r.cnt]));
                if ((countMap['입출금거래내역서'] ?? 0) + newDepositFiles.length > 5) {
                    await transaction.rollback();
                    cleanupUpload(req);
                    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: '입출금거래내역서는 최대 5개까지 첨부할 수 있습니다.' });
                }
                if ((countMap['신분증'] ?? 0) + newIdCardFiles.length > 5) {
                    await transaction.rollback();
                    cleanupUpload(req);
                    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: '신분증은 최대 5개까지 첨부할 수 있습니다.' });
                }
            }
            for (const f of newDepositFiles) await insertFileRecord(transaction, id, f, '입출금거래내역서');
            for (const f of newIdCardFiles) await insertFileRecord(transaction, id, f, '신분증');

            // Sync id_card_file column with first file in RequestFiles
            const remainingFiles = await transaction.request()
                .input('syncId', mssql.Int, id)
                .query('SELECT TOP 1 filename FROM RequestFiles WHERE request_id = @syncId ORDER BY uploaded_at');
            const firstFileName = remainingFiles.recordset[0]?.filename ?? null;
            request.input('id_card_file', mssql.NVarChar, firstFileName);
            setClauses.push('id_card_file = @id_card_file');

            if (setClauses.length === 0) {
                await transaction.rollback();
                return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: '수정할 항목이 없습니다.' });
            }

            await request.query(`UPDATE Requests SET ${setClauses.join(', ')} WHERE id = @id`);
            await transaction.commit();
            return res.json({ success: true });
        } catch (txErr) {
            try { await transaction.rollback(); } catch (rbErr) { /* already rolled back */ }
            cleanupUpload(req);
            throw txErr;
        }
    } catch (err) {
        cleanupUpload(req);
        const classified = classifyError(err, 'PUT /api/admin/request/:id');
        return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: classified });
    }
});

// ── DELETE /api/admin/request/:id/file/:fileId — 개별 파일 삭제 ──
// Express v5: 구체적 경로 먼저 등록
app.delete('/api/admin/request/:id/file/:fileId', authMiddleware, async (req, res) => {
    try {
        const requestId = parseInt(req.params.id, 10);
        const fileId = parseInt(req.params.fileId, 10);
        if (isNaN(requestId) || isNaN(fileId)) return res.status(400).json({ success: false, error: '잘못된 요청입니다.' });
        const pool = await poolPromise;

        // 파일 조회 (request_id 일치 확인)
        const fileResult = await pool.request()
            .input('fileId', mssql.Int, fileId)
            .input('requestId', mssql.Int, requestId)
            .query('SELECT filename FROM RequestFiles WHERE id = @fileId AND request_id = @requestId');
        if (fileResult.recordset.length === 0) {
            return res.status(404).json({ success: false, error: '파일을 찾을 수 없습니다.' });
        }

        // 디스크 삭제
        const fname = fileResult.recordset[0].filename;
        const resolved = path.resolve(uploadDir, fname);
        if (resolved.startsWith(path.resolve(uploadDir))) {
            fs.unlink(resolved, (err) => { if (err && err.code !== 'ENOENT') console.error('unlink error:', err.message); });
        }

        // DB 삭제
        await pool.request().input('delId', mssql.Int, fileId).query('DELETE FROM RequestFiles WHERE id = @delId');

        // Sync id_card_file
        const remaining2 = await pool.request().input('syncId', mssql.Int, requestId)
            .query('SELECT TOP 1 filename FROM RequestFiles WHERE request_id = @syncId ORDER BY uploaded_at');
        const syncFile = remaining2.recordset[0]?.filename ?? null;
        await pool.request()
            .input('syncReqId', mssql.Int, requestId)
            .input('idCardFile', mssql.NVarChar, syncFile)
            .query('UPDATE Requests SET id_card_file = @idCardFile WHERE id = @syncReqId');

        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: classifyError(err, 'DELETE /api/admin/request/:id/file/:fileId') });
    }
});

// ── DELETE /api/admin/request/:id — 요청 삭제 (디스크 파일 + DB CASCADE) ──
app.delete('/api/admin/request/:id', authMiddleware, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ success: false, error: '잘못된 요청 ID입니다.' });
        const pool = await poolPromise;

        // 존재 확인
        const exists = await pool.request().input('id', mssql.Int, id).query('SELECT id FROM Requests WHERE id = @id');
        if (exists.recordset.length === 0) {
            return res.status(404).json({ success: false, error: '요청을 찾을 수 없습니다.' });
        }

        // RequestFiles에서 모든 파일명 조회 → 디스크 삭제
        const filesResult = await pool.request().input('id2', mssql.Int, id)
            .query('SELECT filename FROM RequestFiles WHERE request_id = @id2');
        for (const row of filesResult.recordset) {
            const filePath = path.resolve(uploadDir, row.filename);
            if (filePath.startsWith(path.resolve(uploadDir))) {
                fs.unlink(filePath, (err) => { if (err && err.code !== 'ENOENT') console.error('unlink error:', err.message); });
            }
        }

        // DB 삭제 (ON DELETE CASCADE가 RequestFiles도 처리)
        await pool.request().input('id3', mssql.Int, id).query('DELETE FROM Requests WHERE id = @id3');
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: classifyError(err, 'DELETE /api/admin/request/:id') });
    }
});

app.get('/', (req, res) => res.redirect('/public/index.html'));

// ── 전역 에러 핸들러 (Multer 에러 포함, 항상 JSON 응답) ──
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        const messages = {
            LIMIT_FILE_SIZE: '파일 크기가 10MB를 초과합니다.',
            LIMIT_FILE_COUNT: '파일은 총 최대 10개(카테고리당 5개)까지 업로드할 수 있습니다.',
            LIMIT_UNEXPECTED_FILE: '허용되지 않는 파일 필드입니다.'
        };
        return res.status(400).json({ success: false, error: messages[err.code] || '파일 업로드 중 오류가 발생했습니다.' });
    }
    if (err?.code === 'INVALID_FILE_TYPE') {
        return res.status(400).json({ success: false, error: err.message });
    }
    console.error('Unhandled Error:', err);
    return res.status(500).json({ success: false, error: '서버 내부 오류가 발생했습니다.' });
});

// ╔═══════════════════════════════════════════════════════════╗
// ║  정기 작업 (Cron)                                         ║
// ╚═══════════════════════════════════════════════════════════╝

// 매일 09:00, 17:00 KST — 미완료 사유서 요약 텔레그램 발송
cron.schedule('0 9,17 * * *', async () => {
    // ── 중복 실행 방지용 간단한 파일 락 ──
    const lockFile = path.join(__dirname, '../cron.lock');
    const now = new Date();
    const lockContent = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate() + '-' + now.getHours();

    try {
        if (fs.existsSync(lockFile)) {
            const lastRun = fs.readFileSync(lockFile, 'utf8');
            if (lastRun === lockContent) {
                // 이미 해당 시간대에 실행됨 (다른 인스턴스 등)
                return;
            }
        }
        fs.writeFileSync(lockFile, lockContent);
    } catch (e) {
        console.error('Cron lock failed:', e.message);
    }

    try {
        const pool = await poolPromise;
        // 상태별 집계 (완료/반려 제외)
        const summary = await pool.request().query(`
            SELECT status, COUNT(*) AS cnt
            FROM Requests
            WHERE status NOT IN (N'완료', N'반려')
            GROUP BY status
        `);
        // 최근 20건 미완료 목록
        const recent = await pool.request().query(`
            SELECT TOP 20 request_code, applicant_name, status
            FROM Requests
            WHERE status NOT IN (N'완료', N'반려')
            ORDER BY created_at DESC
        `);

        if (summary.recordset.length === 0) {
            sendTelegramNotification('📋 <b>사유서 현황</b>\n\n미완료 사유서가 없습니다.').catch(() => {});
            return;
        }

        const statusLine = summary.recordset.map(r => `  ${r.status}: ${r.cnt}건`).join('\n');
        const total = summary.recordset.reduce((s, r) => s + r.cnt, 0);
        let listLine = '';
        if (recent.recordset.length > 0) {
            listLine = '\n\n<b>최근 미완료 건:</b>\n' + recent.recordset.map(r => {
                const masked = r.applicant_name ? r.applicant_name.charAt(0) + '**' : '***';
                return `  <code>${r.request_code}</code> ${masked} [${r.status}]`;
            }).join('\n');
        }

        sendTelegramNotification(
            `📋 <b>사유서 현황</b> (미완료 ${total}건)\n\n${statusLine}${listLine}`
        ).catch(() => {});
    } catch (err) {
        console.error('Cron summary failed:', err);
    }
}, { timezone: 'Asia/Seoul' });
// 매일 03:00 KST — DB에 없는 고아 파일 정리
cron.schedule('0 3 * * *', async () => {
    try {
        const pool = await poolPromise;
        const dbFiles = await pool.request().query('SELECT filename FROM RequestFiles');
        const dbSet = new Set(dbFiles.recordset.map(r => r.filename));
        const diskFiles = fs.readdirSync(uploadDir);
        let cleaned = 0;
        for (const file of diskFiles) {
            if (!dbSet.has(file)) {
                const filePath = path.resolve(uploadDir, file);
                if (filePath.startsWith(path.resolve(uploadDir))) {
                    fs.unlinkSync(filePath);
                    cleaned++;
                }
            }
        }
        if (cleaned > 0) {
            logSecurity('ORPHAN_CLEANUP', { filesRemoved: cleaned });
        }
    } catch (err) {
        console.error('Orphan cleanup failed:', err.message);
    }
}, { timezone: 'Asia/Seoul' });

console.log('Cron jobs scheduled: daily 3:00 (orphan cleanup), 9:00, 17:00 KST');

// ── 서버 시작 및 DoS 방어 타임아웃 설정 ──
const server = app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

// Slowloris, 헤더 플러딩 등 저속 공격 방어
server.headersTimeout = 15000;
server.requestTimeout = 30000;
server.timeout = 60000;
server.keepAliveTimeout = 65000;
server.maxRequestsPerSocket = 100;
server.connectionsCheckingInterval = 2000;

// 소켓 에러 핸들러 (EADDRINUSE 등)
server.on('error', (err) => {
    console.error('HTTP server error:', err);
    process.exit(1);
});
