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
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy only if behind a reverse proxy (set TRUST_PROXY=1 in .env)
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// Security headers optimized for internal HTTP and CDN usage
app.use(helmet({
    contentSecurityPolicy: false, 
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false, // Fix COOP error on HTTP
    originAgentCluster: false       // Fix Origin-Agent-Cluster warning
}));

// Middleware
app.use(cors({
    origin: process.env.CORS_ORIGIN || `http://localhost:${process.env.PORT || 3000}`,
    credentials: true
}));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
        trustServerCertificate: true
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
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});

const upload = multer({ 
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB Limit
    fileFilter: (req, file, cb) => {
        // 위험 문자 차단: null byte, 경로 탐색, 제어 문자
        if (/[\x00-\x1f]|\.\.\/|\.\.\\/.test(file.originalname)) {
            const err = new Error("파일명에 허용되지 않는 문자가 포함되어 있습니다.");
            err.code = 'INVALID_FILE_TYPE';
            return cb(err);
        }
        const filetypes = /jpeg|jpg|png/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) return cb(null, true);
        const err = new Error("이미지 파일만 업로드 가능합니다. (JPG, PNG / 최대 10MB)");
        err.code = 'INVALID_FILE_TYPE';
        cb(err);
    }
});

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
                        return res.status(500).json({ success: false, error: '서버 내부 오류가 발생했습니다.' });
                    }
                    res.json({ success: true, user: req.session.user });
                });
            }
        }
        res.status(401).json({ success: false, error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ success: false, error: '서버 내부 오류가 발생했습니다.' });
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

// Helper: 검증 실패 시 multer가 이미 저장한 파일 정리
function cleanupUpload(req) {
    if (req.file) {
        const filePath = path.resolve(uploadDir, req.file.filename);
        if (filePath.startsWith(path.resolve(uploadDir))) {
            fs.unlink(filePath, () => {});
        }
    }
}

// --- Data APIs ---

// Submit Request (Public)
app.post('/api/request', submitLimiter, upload.single('id_card_file'), async (req, res) => {
    try {
        // 서버 입력값 검증
        const d = req.body;
        const required = ['applicant_name', 'applicant_phone', 'request_date', 'deposit_date', 'deposit_amount', 'bank_name', 'refund_account', 'refund_account_name', 'contractor_type', 'merchant_type'];
        for (const field of required) {
            if (!d[field] || !d[field].trim()) {
                cleanupUpload(req);
                return res.status(400).json({ success: false, error: `필수 항목이 누락되었습니다: ${field}` });
            }
        }
        if (d.applicant_name.length > 20) { cleanupUpload(req); return res.status(400).json({ success: false, error: '신청인 이름은 20자 이내여야 합니다.' }); }
        if (d.applicant_phone.replace(/\D/g, '').length < 10) { cleanupUpload(req); return res.status(400).json({ success: false, error: '올바른 전화번호를 입력해 주세요.' }); }
        if (!['true', '1', 'on'].includes(d.terms_agreed)) { cleanupUpload(req); return res.status(400).json({ success: false, error: '개인정보 활용 동의는 필수입니다.' }); }
        if (!req.file) { return res.status(400).json({ success: false, error: '신분증 파일은 필수입니다.' }); }
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

        await pool.request()
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
            .input('idCardFile', mssql.NVarChar, req.file ? req.file.filename : null)
            .input('termsAgreed', mssql.Bit, ['true', '1', 'on'].includes(d.terms_agreed) ? 1 : 0)
            .input('termsIp', mssql.NVarChar, (req.ip || '').replace(/^::ffff:/, '') || null)
            .query(`INSERT INTO Requests (request_code, request_date, deposit_date, deposit_amount, bank_name, user_account, user_account_name, contractor_code, merchant_code, applicant_name, applicant_phone, details, id_card_file, terms_agreed, terms_ip)
                    VALUES (@requestCode, @requestDate, @depositDate, @depositAmount, @bankName, @userAccount, @userAccountName, @contractorCode, @merchantCode, @applicantName, @applicantPhone, @details, @idCardFile, @termsAgreed, @termsIp)`);

        res.json({ success: true, requestCode });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Status Check (Public)
app.get('/api/status/:code', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('code', mssql.NVarChar, req.params.code)
            .query('SELECT applicant_name, status, created_at FROM Requests WHERE request_code = @code');
        if (result.recordset.length > 0) {
            const row = result.recordset[0];
            res.json({ success: true, data: { ...row, applicant_name: row.applicant_name[0] + '**' } });
        } else res.status(404).json({ success: false });
    } catch (err) { res.status(500).json({ success: false }); }
});

// Admin APIs (Protected)
app.get('/api/admin/requests', authMiddleware, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query('SELECT * FROM Requests ORDER BY created_at DESC');
        res.json({ success: true, data: result.recordset });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.get('/api/admin/request/:id', authMiddleware, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().input('id', mssql.Int, req.params.id).query('SELECT * FROM Requests WHERE id = @id');
        res.json({ success: true, data: result.recordset[0] });
    } catch (err) { res.status(500).json({ success: false }); }
});

// Create Request (Admin)
app.post('/api/admin/request', authMiddleware, upload.single('id_card_file'), async (req, res) => {
    try {
        const d = req.body;
        const required = ['applicant_name', 'applicant_phone', 'request_date', 'deposit_date', 'deposit_amount', 'bank_name', 'refund_account', 'refund_account_name', 'contractor_type', 'merchant_type'];
        for (const field of required) {
            if (!d[field] || !d[field].trim()) {
                cleanupUpload(req);
                return res.status(400).json({ success: false, error: `필수 항목이 누락되었습니다: ${field}` });
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

        await pool.request()
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
            .input('idCardFile', mssql.NVarChar, req.file ? req.file.filename : null)
            .input('termsAgreed', mssql.Bit, ['true', '1', 'on'].includes(d.terms_agreed) ? 1 : 0)
            .input('termsIp', mssql.NVarChar, null)
            .query(`INSERT INTO Requests (request_code, request_date, deposit_date, deposit_amount, bank_name, user_account, user_account_name, contractor_code, merchant_code, applicant_name, applicant_phone, details, id_card_file, terms_agreed, terms_ip)
                    VALUES (@requestCode, @requestDate, @depositDate, @depositAmount, @bankName, @userAccount, @userAccountName, @contractorCode, @merchantCode, @applicantName, @applicantPhone, @details, @idCardFile, @termsAgreed, @termsIp)`);

        res.json({ success: true, requestCode });
    } catch (err) {
        console.error('Admin Create Error:', err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

app.put('/api/admin/status', authMiddleware, async (req, res) => {
    try {
        const { id, status } = req.body;
        const pool = await poolPromise;
        await pool.request().input('id', mssql.Int, id).input('status', mssql.NVarChar, status).query('UPDATE Requests SET status = @status WHERE id = @id');
        res.json({ success: true });
    } catch (err) { console.error('Status Update Error:', err); res.status(500).json({ success: false, error: '상태 변경 중 오류가 발생했습니다.' }); }
});

// Update Request (Admin) — supports multipart/form-data (file upload) and JSON
app.put('/api/admin/request/:id', authMiddleware, upload.single('id_card_file'), async (req, res) => {
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

        // Helper: delete old file from disk (with path traversal guard)
        const deleteOldFile = async () => {
            const existing = await pool.request().input('fid', mssql.Int, id)
                .query('SELECT id_card_file FROM Requests WHERE id = @fid');
            const oldFile = existing.recordset[0]?.id_card_file;
            if (oldFile) {
                const resolved = path.resolve(uploadDir, oldFile);
                if (!resolved.startsWith(path.resolve(uploadDir))) return;
                fs.unlink(resolved, () => {});
            }
        };

        // File replace: new file uploaded
        if (req.file) {
            await deleteOldFile();
            request.input('id_card_file', mssql.NVarChar, req.file.filename);
            setClauses.push('id_card_file = @id_card_file');
        }
        // File delete: _delete_file flag
        else if (d._delete_file === '1' || d._delete_file === 1) {
            await deleteOldFile();
            request.input('id_card_file', mssql.NVarChar, null);
            setClauses.push('id_card_file = @id_card_file');
        }

        if (setClauses.length === 0) {
            return res.status(400).json({ success: false, error: '수정할 항목이 없습니다.' });
        }

        await request.query(`UPDATE Requests SET ${setClauses.join(', ')} WHERE id = @id`);
        res.json({ success: true });
    } catch (err) {
        console.error('Request Update Error:', err);
        res.status(500).json({ success: false, error: '수정 중 오류가 발생했습니다.' });
    }
});

// Delete Request (Admin)
app.delete('/api/admin/request/:id', authMiddleware, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ success: false, error: '잘못된 요청 ID입니다.' });
        const pool = await poolPromise;

        // 첨부파일 조회 후 삭제
        const result = await pool.request().input('id', mssql.Int, id).query('SELECT id_card_file FROM Requests WHERE id = @id');
        if (result.recordset.length === 0) {
            return res.status(404).json({ success: false, error: '요청을 찾을 수 없습니다.' });
        }

        const filename = result.recordset[0].id_card_file;
        if (filename) {
            const filePath = path.resolve(uploadDir, filename);
            if (filePath.startsWith(path.resolve(uploadDir))) {
                fs.unlink(filePath, () => {}); // 파일 없어도 무시
            }
        }

        await pool.request().input('id', mssql.Int, id).query('DELETE FROM Requests WHERE id = @id');
        res.json({ success: true });
    } catch (err) {
        console.error('Request Delete Error:', err);
        res.status(500).json({ success: false, error: '삭제 중 오류가 발생했습니다.' });
    }
});

app.get('/', (req, res) => res.redirect('/public/index.html'));

// Multer / global error handler — JSON 응답 보장
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        const messages = {
            LIMIT_FILE_SIZE: '파일 크기가 10MB를 초과합니다.',
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

app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
