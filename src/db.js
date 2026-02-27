/**
 * db.js — MSSQL 데이터베이스 연결 모듈
 *
 * 앱 전체에서 공유하는 단일 커넥션 풀(poolPromise)을 생성·내보냄.
 * server.js에서 `require('./db')` 로 가져다 사용.
 */
const mssql = require('mssql');
require('dotenv').config();

// .env 기반 MSSQL 접속 설정
const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT) || 1433,
    options: {
        encrypt: true,
        trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === 'true',
    }
};

// 앱 시작 시 한 번 연결하여 풀을 생성 (async IIFE 싱글턴)
const poolPromise = (async () => {
    try {
        const pool = await new mssql.ConnectionPool(dbConfig).connect();
        console.log('Connected to MSSQL Database');
        return pool;
    } catch (err) {
        console.error('Database Connection Failed! Bad Config: ', err);
        throw err;
    }
})();

module.exports = {
    mssql,       // 타입 상수(mssql.Int, mssql.NVarChar 등) 접근용
    poolPromise  // 실제 DB 쿼리 실행 시 await 하여 pool 획득
};
