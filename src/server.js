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
require('dotenv').config();

// 타이밍 사이드채널 방어용 더미 해시 (존재하지 않는 유저 요청 시 bcrypt 연산 균등화)
const DUMMY_HASH = '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012';

// ── 에러 분류 헬퍼 ──
function classifyError(err, context) {
    // MSSQL 에러 번호별 한글 매핑
    if (err && err.number) {
        switch (err.number) {
            case 2627: case 2601: return '중복된 데이터가 존재합니다.';
            case 547: return '데이터 무결성 제약 조건에 위배됩니다.';
            case 8152: return '입력 값이 허용 길이를 초과합니다.';
            case 245: case 8114: return '입력 값의 형식이 올바르지 않습니다.';
        }
    }
    // MSSQL 연결 에러
    if (err && (err.code === 'ESOCKET' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEOUT')) {
        return '데이터베이스 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.';
    }
    console.error(`[${context}]`, err);
    return '서버 처리 중 오류가 발생했습니다. 문제가 계속되면 관리자에게 문의해 주세요.';
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

// Telegram notification helper (fire-and-forget, no extra dependencies)
async function sendTelegramNotification(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
        });
    } catch (err) { console.error('Telegram notification failed:', err.message); }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy only if behind a reverse proxy (set TRUST_PROXY=1 in .env)
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// Security headers with CSP whitelist for CDN resources
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'",
                "https://cdn.tailwindcss.com",
                "https://cdn.jsdelivr.net",
                "https://code.jquery.com",
                "https://cdn.datatables.net",
                "https://cdnjs.cloudflare.com"],
            styleSrc: ["'self'", "'unsafe-inline'",
                "https://cdn.tailwindcss.com",
                "https://cdn.jsdelivr.net",
                "https://cdn.datatables.net"],
            imgSrc: ["'self'", "data:", "blob:"],
            fontSrc: ["'self'", "https://cdn.jsdelivr.net"],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'self'"],
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false
}));

// Middleware
app.use(cors({
    origin: process.env.CORS_ORIGIN || `http://localhost:${process.env.PORT || 3000}`,
    credentials: true
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use('/public', express.static(path.join(__dirname, '../public')));

// 1. Persistent Session Configuration
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

// Uploads: 인증된 관리자만 접근 가능 (세션 미들웨어 이후에 등록)
app.use('/uploads', (req, res, next) => {
    if (req.session && req.session.user) return next();
    res.status(403).json({ error: 'Forbidden' });
}, express.static(path.join(__dirname, '../uploads')));

// Auth Middleware
const authMiddleware = (req, res, next) => {
    if (req.session && req.session.user) {
        next();
    } else {
        res.status(401).json({ success: false, error: 'Unauthorized access' });
    }
};

// Ensure upload directory exists
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer Storage
// Multer는 Content-Disposition 파일명을 latin1으로 디코딩하므로 한글이 깨짐 → UTF-8 복원
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

// Multer 후처리 미들웨어: req.files 내 모든 파일의 originalname을 UTF-8로 재변환
// (busboy가 latin1으로 디코딩한 파일명을 storage.filename에서 한 번 고쳤지만,
//  multer v2가 내부적으로 originalname을 다시 세팅하는 경우가 있어 최종 보정)
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
                // 파일 내용이 허용 형식이 아님 → 모든 업로드 파일 삭제
                cleanupUpload(req);
                return res.status(400).json({ success: false, error: `'${file.originalname}' 파일의 실제 형식이 허용되지 않습니다. JPG, PNG, PDF 파일만 업로드 가능합니다.` });
            }
        } catch (e) {
            // 파일 읽기 실패 시 거부
            cleanupUpload(req);
            return res.status(400).json({ success: false, error: '업로드된 파일을 검증할 수 없습니다.' });
        }
    }
    next();
}

// --- Auth APIs ---

// Rate limiting: 로그인 15분당 10회
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

// Login
app.post('/api/admin/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, error: '아이디와 비밀번호를 입력해 주세요.' });
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
                req.session.user = { id: user.id, username: user.username, name: user.name };
                await pool.request().input('id', mssql.Int, user.id).query('UPDATE Users SET last_login = GETDATE() WHERE id = @id');

                return req.session.save((err) => {
                    if (err) {
                        console.error('Session Save Error:', err);
                        return res.status(500).json({ success: false, error: '세션 저장 중 오류가 발생했습니다. 다시 시도해 주세요.' });
                    }
                    res.json({ success: true, user: req.session.user });
                });
            }
        } else {
            await bcrypt.compare(password, DUMMY_HASH);
        }
        res.status(401).json({ success: false, error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    } catch (err) {
        res.status(500).json({ success: false, error: classifyError(err, 'POST /api/admin/login') });
    }
});

// Check Session
app.get('/api/admin/me', (req, res) => {
    if (req.session.user) res.json({ success: true, user: req.session.user });
    else res.status(401).json({ success: false });
});

// Logout
app.post('/api/admin/logout', (req, res) => {
    req.session.destroy((err) => {
        res.clearCookie('reasonsform.sid');
        res.json({ success: true });
    });
});

// Helper: 검증 실패 시 multer가 이미 저장한 파일 정리 (fields/array/single 대응)
function cleanupUpload(req) {
    let files = [];
    if (req.file) {
        files = [req.file];
    } else if (req.files) {
        if (Array.isArray(req.files)) {
            files = req.files;
        } else {
            // upload.fields() 형식: { fieldName: [File, ...] }
            for (const fieldFiles of Object.values(req.files)) {
                files.push(...fieldFiles);
            }
        }
    }
    for (const f of files) {
        const filePath = path.resolve(uploadDir, f.filename);
        if (filePath.startsWith(path.resolve(uploadDir))) {
            fs.unlink(filePath, (err) => {
                if (err && err.code !== 'ENOENT') console.error('cleanupUpload unlink error:', err.message);
            });
        }
    }
}

// Helper: upload.fields() 결과에서 모든 파일을 flat 배열로 반환
function getAllUploadedFiles(req) {
    if (!req.files) return [];
    if (Array.isArray(req.files)) return req.files;
    const files = [];
    for (const fieldFiles of Object.values(req.files)) {
        files.push(...fieldFiles);
    }
    return files;
}

// --- Data APIs ---

// Submit Request (Public)
app.post('/api/request', submitLimiter, upload.fields([{ name: 'deposit_files', maxCount: 5 }, { name: 'id_card_files', maxCount: 5 }]), fixUploadedFileNames, validateFileMagic, async (req, res) => {
    try {
        // 서버 입력값 검증
        const d = req.body;
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
        if (!['true', '1', 'on'].includes(d.terms_agreed)) { cleanupUpload(req); return res.status(400).json({ success: false, error: '개인정보 활용 동의는 필수입니다.' }); }
        const depositFiles = (req.files && req.files.deposit_files) || [];
        const idCardFiles = (req.files && req.files.id_card_files) || [];
        if (depositFiles.length === 0) { cleanupUpload(req); return res.status(400).json({ success: false, error: '입금내역서 파일은 최소 1개 필수입니다.' }); }
        if (idCardFiles.length === 0) { cleanupUpload(req); return res.status(400).json({ success: false, error: '신분증 파일은 최소 1개 필수입니다.' }); }
        if (new Date(d.deposit_date) > new Date(d.request_date)) { cleanupUpload(req); return res.status(400).json({ success: false, error: '입금일자는 신청일자와 같거나 이전이어야 합니다.' }); }

        const pool = await poolPromise;
        const date = new Date();
        const datePrefix = `${date.getFullYear().toString().slice(-2)}${(date.getMonth()+1).toString().padStart(2,'0')}${date.getDate().toString().padStart(2,'0')}`;

        // 당일 최대 순번 조회 후 +1, 암호학적 랜덤 3자리 추가 (추측 방지)
        const seqResult = await pool.request()
            .input('prefix', mssql.NVarChar, `${datePrefix}-%`)
            .query("SELECT COUNT(*) AS cnt FROM Requests WHERE request_code LIKE @prefix");
        const nextSeq = (seqResult.recordset[0].cnt || 0) + 1;
        const rand = crypto.randomBytes(2).toString('hex').toUpperCase().slice(0, 3);
        const requestCode = `${datePrefix}-${String(nextSeq).padStart(3, '0')}-${rand}`;

        const allFiles = [...depositFiles, ...idCardFiles];
        const firstFile = allFiles.length > 0 ? allFiles[0].filename : null;

        const insertResult = await pool.request()
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
            .input('details', mssql.NVarChar, d.details)
            .input('idCardFile', mssql.NVarChar, firstFile)
            .input('termsAgreed', mssql.Bit, ['true', '1', 'on'].includes(d.terms_agreed) ? 1 : 0)
            .input('termsIp', mssql.NVarChar, (req.ip || '').replace(/^::ffff:/, '') || null)
            .query(`INSERT INTO Requests (request_code, request_date, deposit_date, deposit_amount, bank_name, user_account, user_account_name, contractor_code, merchant_code, applicant_name, applicant_phone, details, id_card_file, terms_agreed, terms_ip)
                    OUTPUT INSERTED.id
                    VALUES (@requestCode, @requestDate, @depositDate, @depositAmount, @bankName, @userAccount, @userAccountName, @contractorCode, @merchantCode, @applicantName, @applicantPhone, @details, @idCardFile, @termsAgreed, @termsIp)`);

        const requestId = insertResult.recordset[0].id;

        // Insert files into RequestFiles with category
        try {
            for (const f of depositFiles) {
                const ext = path.extname(f.originalname).toLowerCase().replace('.', '');
                await pool.request()
                    .input('requestId', mssql.Int, requestId)
                    .input('filename', mssql.NVarChar, f.filename)
                    .input('originalName', mssql.NVarChar, f.originalname)
                    .input('fileType', mssql.NVarChar, ext)
                    .input('category', mssql.NVarChar, '입금내역서')
                    .query('INSERT INTO RequestFiles (request_id, filename, original_name, file_type, category) VALUES (@requestId, @filename, @originalName, @fileType, @category)');
            }
            for (const f of idCardFiles) {
                const ext = path.extname(f.originalname).toLowerCase().replace('.', '');
                await pool.request()
                    .input('requestId', mssql.Int, requestId)
                    .input('filename', mssql.NVarChar, f.filename)
                    .input('originalName', mssql.NVarChar, f.originalname)
                    .input('fileType', mssql.NVarChar, ext)
                    .input('category', mssql.NVarChar, '신분증')
                    .query('INSERT INTO RequestFiles (request_id, filename, original_name, file_type, category) VALUES (@requestId, @filename, @originalName, @fileType, @category)');
            }
        } catch (fileErr) {
            console.error('File metadata insert error:', fileErr);
            cleanupUpload(req);
            return res.status(500).json({ success: false, error: '파일 정보 저장 중 오류가 발생했습니다. 사유서는 접수되었으나 파일 첨부에 실패했습니다.' });
        }

        res.json({ success: true, requestCode });

        // Fire-and-forget Telegram notification
        const kstTime = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
        const amountFmt = Number(d.deposit_amount.replace(/\D/g, '')).toLocaleString('ko-KR');
        const maskedName = d.applicant_name ? d.applicant_name.charAt(0) + '**' : '***';
        sendTelegramNotification(
            `<b>새 사유서 접수</b>\n식별코드: <code>${requestCode}</code>\n신청인: ${maskedName}\n파일: ${allFiles.length}개\n접수시간: ${kstTime}`
        );
    } catch (err) {
        cleanupUpload(req);
        res.status(500).json({ success: false, error: classifyError(err, 'POST /api/request') });
    }
});

// Rate limiting: 상태조회 15분당 30회
const statusLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: { success: false, error: '조회 횟수를 초과했습니다. 잠시 후 다시 시도해 주세요.' },
    standardHeaders: true,
    legacyHeaders: false
});

// Status Check (Public)
app.get('/api/status/:code', statusLimiter, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('code', mssql.NVarChar, req.params.code)
            .query('SELECT applicant_name, status, created_at FROM Requests WHERE request_code = @code');
        if (result.recordset.length > 0) {
            const row = result.recordset[0];
            res.json({ success: true, data: { ...row, applicant_name: row.applicant_name[0] + '**' } });
        } else res.status(404).json({ success: false, error: '해당 식별코드로 접수된 사유서를 찾을 수 없습니다.' });
    } catch (err) { res.status(500).json({ success: false, error: classifyError(err, 'GET /api/status') }); }
});

// Admin APIs (Protected)
app.get('/api/admin/requests', authMiddleware, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT r.*, (SELECT COUNT(*) FROM RequestFiles rf WHERE rf.request_id = r.id) AS file_count
            FROM Requests r ORDER BY r.created_at DESC
        `);
        res.json({ success: true, data: result.recordset });
    } catch (err) { res.status(500).json({ success: false, error: classifyError(err, 'GET /api/admin/requests') }); }
});

app.get('/api/admin/request/:id', authMiddleware, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().input('id', mssql.Int, req.params.id).query('SELECT * FROM Requests WHERE id = @id');
        const files = await pool.request().input('id2', mssql.Int, req.params.id)
            .query('SELECT * FROM RequestFiles WHERE request_id = @id2 ORDER BY uploaded_at');
        const data = result.recordset[0];
        if (!data) return res.status(404).json({ success: false, error: '상세 정보를 찾을 수 없습니다.' });
        data.files = files.recordset;
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: classifyError(err, 'GET /api/admin/request/:id') }); }
});

// Add Files to Request (Admin) — 상세보기에서 카테고리별 파일 추가
// NOTE: Express v5에서는 구체적 경로(/:id/files)가 덜 구체적 경로(/) 앞에 등록되어야 함
app.post('/api/admin/request/:id/files', authMiddleware, upload.fields([{ name: 'deposit_files', maxCount: 5 }, { name: 'id_card_files', maxCount: 5 }]), fixUploadedFileNames, validateFileMagic, async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        if (isNaN(requestId)) { cleanupUpload(req); return res.status(400).json({ success: false, error: '잘못된 요청 ID입니다.' }); }
        const pool = await poolPromise;

        // 존재 확인
        const exists = await pool.request().input('id', mssql.Int, requestId).query('SELECT id FROM Requests WHERE id = @id');
        if (exists.recordset.length === 0) { cleanupUpload(req); return res.status(404).json({ success: false, error: '요청을 찾을 수 없습니다.' }); }

        // 카테고리별 현재 파일 수 확인
        const counts = await pool.request().input('reqId', mssql.Int, requestId)
            .query("SELECT category, COUNT(*) AS cnt FROM RequestFiles WHERE request_id = @reqId GROUP BY category");
        const countMap = {};
        counts.recordset.forEach(r => { countMap[r.category] = r.cnt; });

        const addDepositFiles = (req.files && req.files.deposit_files) || [];
        const addIdCardFiles = (req.files && req.files.id_card_files) || [];

        if ((countMap['입금내역서'] || 0) + addDepositFiles.length > 5) {
            cleanupUpload(req);
            return res.status(400).json({ success: false, error: '입금내역서는 최대 5개까지 첨부할 수 있습니다.' });
        }
        if ((countMap['신분증'] || 0) + addIdCardFiles.length > 5) {
            cleanupUpload(req);
            return res.status(400).json({ success: false, error: '신분증은 최대 5개까지 첨부할 수 있습니다.' });
        }

        for (const f of addDepositFiles) {
            const ext = path.extname(f.originalname).toLowerCase().replace('.', '');
            await pool.request()
                .input('requestId', mssql.Int, requestId)
                .input('filename', mssql.NVarChar, f.filename)
                .input('originalName', mssql.NVarChar, f.originalname)
                .input('fileType', mssql.NVarChar, ext)
                .input('category', mssql.NVarChar, '입금내역서')
                .query('INSERT INTO RequestFiles (request_id, filename, original_name, file_type, category) VALUES (@requestId, @filename, @originalName, @fileType, @category)');
        }
        for (const f of addIdCardFiles) {
            const ext = path.extname(f.originalname).toLowerCase().replace('.', '');
            await pool.request()
                .input('requestId', mssql.Int, requestId)
                .input('filename', mssql.NVarChar, f.filename)
                .input('originalName', mssql.NVarChar, f.originalname)
                .input('fileType', mssql.NVarChar, ext)
                .input('category', mssql.NVarChar, '신분증')
                .query('INSERT INTO RequestFiles (request_id, filename, original_name, file_type, category) VALUES (@requestId, @filename, @originalName, @fileType, @category)');
        }

        // Sync id_card_file
        const remaining = await pool.request().input('syncId', mssql.Int, requestId)
            .query('SELECT TOP 1 filename FROM RequestFiles WHERE request_id = @syncId ORDER BY uploaded_at');
        const firstFile = remaining.recordset.length > 0 ? remaining.recordset[0].filename : null;
        await pool.request()
            .input('syncReqId', mssql.Int, requestId)
            .input('idCardFile', mssql.NVarChar, firstFile)
            .query('UPDATE Requests SET id_card_file = @idCardFile WHERE id = @syncReqId');

        res.json({ success: true, added: addDepositFiles.length + addIdCardFiles.length });
    } catch (err) {
        cleanupUpload(req);
        res.status(500).json({ success: false, error: classifyError(err, 'POST /api/admin/request/:id/files') });
    }
});

// Create Request (Admin)
app.post('/api/admin/request', authMiddleware, upload.fields([{ name: 'deposit_files', maxCount: 5 }, { name: 'id_card_files', maxCount: 5 }]), fixUploadedFileNames, validateFileMagic, async (req, res) => {
    try {
        const d = req.body;
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
        const date = new Date();
        const datePrefix = `${date.getFullYear().toString().slice(-2)}${(date.getMonth()+1).toString().padStart(2,'0')}${date.getDate().toString().padStart(2,'0')}`;

        const seqResult = await pool.request()
            .input('prefix', mssql.NVarChar, `${datePrefix}-%`)
            .query("SELECT COUNT(*) AS cnt FROM Requests WHERE request_code LIKE @prefix");
        const nextSeq = (seqResult.recordset[0].cnt || 0) + 1;
        const rand = crypto.randomBytes(2).toString('hex').toUpperCase().slice(0, 3);
        const requestCode = `${datePrefix}-${String(nextSeq).padStart(3, '0')}-${rand}`;

        const adminDepositFiles = (req.files && req.files.deposit_files) || [];
        const adminIdCardFiles = (req.files && req.files.id_card_files) || [];
        const allAdminFiles = [...adminDepositFiles, ...adminIdCardFiles];
        const firstFile = allAdminFiles.length > 0 ? allAdminFiles[0].filename : null;

        const insertResult = await pool.request()
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
            .query(`INSERT INTO Requests (request_code, request_date, deposit_date, deposit_amount, bank_name, user_account, user_account_name, contractor_code, merchant_code, applicant_name, applicant_phone, details, id_card_file, terms_agreed, terms_ip)
                    OUTPUT INSERTED.id
                    VALUES (@requestCode, @requestDate, @depositDate, @depositAmount, @bankName, @userAccount, @userAccountName, @contractorCode, @merchantCode, @applicantName, @applicantPhone, @details, @idCardFile, @termsAgreed, @termsIp)`);

        const requestId = insertResult.recordset[0].id;
        try {
            for (const f of adminDepositFiles) {
                const ext = path.extname(f.originalname).toLowerCase().replace('.', '');
                await pool.request()
                    .input('requestId', mssql.Int, requestId)
                    .input('filename', mssql.NVarChar, f.filename)
                    .input('originalName', mssql.NVarChar, f.originalname)
                    .input('fileType', mssql.NVarChar, ext)
                    .input('category', mssql.NVarChar, '입금내역서')
                    .query('INSERT INTO RequestFiles (request_id, filename, original_name, file_type, category) VALUES (@requestId, @filename, @originalName, @fileType, @category)');
            }
            for (const f of adminIdCardFiles) {
                const ext = path.extname(f.originalname).toLowerCase().replace('.', '');
                await pool.request()
                    .input('requestId', mssql.Int, requestId)
                    .input('filename', mssql.NVarChar, f.filename)
                    .input('originalName', mssql.NVarChar, f.originalname)
                    .input('fileType', mssql.NVarChar, ext)
                    .input('category', mssql.NVarChar, '신분증')
                    .query('INSERT INTO RequestFiles (request_id, filename, original_name, file_type, category) VALUES (@requestId, @filename, @originalName, @fileType, @category)');
            }
        } catch (fileErr) {
            console.error('Admin file metadata insert error:', fileErr);
            cleanupUpload(req);
            return res.status(500).json({ success: false, error: '파일 정보 저장 중 오류가 발생했습니다.' });
        }

        res.json({ success: true, requestCode });
    } catch (err) {
        cleanupUpload(req);
        res.status(500).json({ success: false, error: classifyError(err, 'POST /api/admin/request') });
    }
});

app.put('/api/admin/status', authMiddleware, async (req, res) => {
    try {
        const { id, status } = req.body;

        // 허용 상태값 검증
        const ALLOWED_STATUSES = ['대기', '접수', '처리중', '완료', '반려'];
        if (!ALLOWED_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, error: '유효하지 않은 상태값입니다.' });
        }
        if (!id || isNaN(Number(id))) {
            return res.status(400).json({ success: false, error: '유효하지 않은 요청 ID입니다.' });
        }

        // 워크플로 전환 검증
        const TRANSITIONS = {
            '대기': ['접수', '반려'],
            '접수': ['처리중', '반려'],
            '처리중': ['완료', '반려'],
            '완료': [],
            '반려': ['대기']
        };

        const pool = await poolPromise;
        const current = await pool.request().input('id', mssql.Int, id).query('SELECT status FROM Requests WHERE id = @id');
        if (current.recordset.length === 0) {
            return res.status(404).json({ success: false, error: '해당 사유서를 찾을 수 없습니다.' });
        }

        const currentStatus = current.recordset[0].status;
        const allowed = TRANSITIONS[currentStatus] || [];
        if (!allowed.includes(status)) {
            return res.status(400).json({ success: false, error: `'${currentStatus}' 상태에서 '${status}'(으)로 변경할 수 없습니다.` });
        }

        await pool.request().input('id', mssql.Int, id).input('status', mssql.NVarChar, status).query('UPDATE Requests SET status = @status WHERE id = @id');
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: classifyError(err, 'PUT /api/admin/status') }); }
});

// Update Request (Admin) — supports multipart/form-data (file upload) and JSON
app.put('/api/admin/request/:id', authMiddleware, upload.fields([{ name: 'deposit_files', maxCount: 5 }, { name: 'id_card_files', maxCount: 5 }]), fixUploadedFileNames, validateFileMagic, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
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

        // 입금일자 ≤ 신청일자 검증 (둘 다 전송된 경우)
        if (d.deposit_date && d.request_date && new Date(d.deposit_date) > new Date(d.request_date)) {
            cleanupUpload(req);
            return res.status(400).json({ success: false, error: '입금일자는 신청일자와 같거나 이전이어야 합니다.' });
        }

        const setClauses = [];
        const request = pool.request().input('id', mssql.Int, id);

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
                    return res.status(400).json({ success: false, error: '삭제할 파일 정보가 올바르지 않습니다.' });
                }
                for (const fileId of deleteIds) {
                    if (!Number.isInteger(fileId) || fileId < 1) continue;
                    const fileResult = await pool.request()
                        .input('fileId', mssql.Int, fileId)
                        .input('reqId', mssql.Int, id)
                        .query('SELECT filename FROM RequestFiles WHERE id = @fileId AND request_id = @reqId');
                    if (fileResult.recordset.length > 0) {
                        const fname = fileResult.recordset[0].filename;
                        const resolved = path.resolve(uploadDir, fname);
                        if (resolved.startsWith(path.resolve(uploadDir))) {
                            fs.unlink(resolved, (err) => { if (err && err.code !== 'ENOENT') console.error('unlink error:', err.message); });
                        }
                        await pool.request()
                            .input('delId', mssql.Int, fileId)
                            .query('DELETE FROM RequestFiles WHERE id = @delId');
                    }
                }
            } catch (e) {
                cleanupUpload(req);
                return res.status(400).json({ success: false, error: '삭제할 파일 정보가 올바르지 않습니다.' });
            }
        }

        // Handle new file uploads with category
        const newDepositFiles = (req.files && req.files.deposit_files) || [];
        const newIdCardFiles = (req.files && req.files.id_card_files) || [];
        for (const f of newDepositFiles) {
            const ext = path.extname(f.originalname).toLowerCase().replace('.', '');
            await pool.request()
                .input('requestId', mssql.Int, id)
                .input('filename', mssql.NVarChar, f.filename)
                .input('originalName', mssql.NVarChar, f.originalname)
                .input('fileType', mssql.NVarChar, ext)
                .input('category', mssql.NVarChar, '입금내역서')
                .query('INSERT INTO RequestFiles (request_id, filename, original_name, file_type, category) VALUES (@requestId, @filename, @originalName, @fileType, @category)');
        }
        for (const f of newIdCardFiles) {
            const ext = path.extname(f.originalname).toLowerCase().replace('.', '');
            await pool.request()
                .input('requestId', mssql.Int, id)
                .input('filename', mssql.NVarChar, f.filename)
                .input('originalName', mssql.NVarChar, f.originalname)
                .input('fileType', mssql.NVarChar, ext)
                .input('category', mssql.NVarChar, '신분증')
                .query('INSERT INTO RequestFiles (request_id, filename, original_name, file_type, category) VALUES (@requestId, @filename, @originalName, @fileType, @category)');
        }

        // Sync id_card_file column with first file in RequestFiles
        const remainingFiles = await pool.request()
            .input('syncId', mssql.Int, id)
            .query('SELECT TOP 1 filename FROM RequestFiles WHERE request_id = @syncId ORDER BY uploaded_at');
        const firstFileName = remainingFiles.recordset.length > 0 ? remainingFiles.recordset[0].filename : null;
        request.input('id_card_file', mssql.NVarChar, firstFileName);
        setClauses.push('id_card_file = @id_card_file');

        if (setClauses.length === 0) {
            return res.status(400).json({ success: false, error: '수정할 항목이 없습니다.' });
        }

        await request.query(`UPDATE Requests SET ${setClauses.join(', ')} WHERE id = @id`);
        res.json({ success: true });
    } catch (err) {
        cleanupUpload(req);
        res.status(500).json({ success: false, error: classifyError(err, 'PUT /api/admin/request/:id') });
    }
});

// Delete Single File (Admin) — 상세보기에서 개별 파일 삭제
// NOTE: Express v5에서는 구체적 경로(/:id/file/:fileId)가 덜 구체적 경로(/:id) 앞에 등록되어야 함
app.delete('/api/admin/request/:id/file/:fileId', authMiddleware, async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const fileId = parseInt(req.params.fileId);
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
        const remaining = await pool.request().input('syncId', mssql.Int, requestId)
            .query('SELECT TOP 1 filename FROM RequestFiles WHERE request_id = @syncId ORDER BY uploaded_at');
        const firstFile = remaining.recordset.length > 0 ? remaining.recordset[0].filename : null;
        await pool.request()
            .input('syncReqId', mssql.Int, requestId)
            .input('idCardFile', mssql.NVarChar, firstFile)
            .query('UPDATE Requests SET id_card_file = @idCardFile WHERE id = @syncReqId');

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: classifyError(err, 'DELETE /api/admin/request/:id/file/:fileId') });
    }
});

// Delete Request (Admin)
app.delete('/api/admin/request/:id', authMiddleware, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
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
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: classifyError(err, 'DELETE /api/admin/request/:id') });
    }
});

app.get('/', (req, res) => res.redirect('/public/index.html'));

// Multer / global error handler — JSON 응답 보장
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        const messages = {
            LIMIT_FILE_SIZE: '파일 크기가 10MB를 초과합니다.',
            LIMIT_FILE_COUNT: '파일은 총 최대 10개(카테고리당 5개)까지 업로드할 수 있습니다.',
            LIMIT_UNEXPECTED_FILE: '허용되지 않는 파일 필드입니다.'
        };
        return res.status(400).json({ success: false, error: messages[err.code] || '파일 업로드 중 오류가 발생했습니다.' });
    }
    if (err && err.code === 'INVALID_FILE_TYPE') {
        return res.status(400).json({ success: false, error: err.message });
    }
    console.error('Unhandled Error:', err);
    res.status(500).json({ success: false, error: '서버 내부 오류가 발생했습니다.' });
});

// Cron: 매일 9시, 17시 미완료 사유서 요약 텔레그램 발송
cron.schedule('0 9,17 * * *', async () => {
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
            sendTelegramNotification('📋 <b>사유서 현황</b>\n\n미완료 사유서가 없습니다.');
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
        );
    } catch (err) {
        console.error('Cron summary failed:', err.message);
    }
}, { timezone: 'Asia/Seoul' });
console.log('Cron jobs scheduled: daily 9:00, 17:00 KST');

const server = app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

// DoS 방어: Slowloris, 헤더 플러딩 방지
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
