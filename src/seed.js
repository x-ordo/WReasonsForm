const { poolPromise, mssql } = require('./db');

async function seedData() {
    console.log('--- Starting Data Seeding ---');
    try {
        const pool = await poolPromise;
        
        const sampleData = [
            { code: 'REQ-260221-A1B2', name: '김철수', phone: '01012345678', amount: 55000, merchant: '스타벅스 강남점', status: '대기', details: '실수로 두 번 입금했습니다.' },
            { code: 'REQ-260221-C3D4', name: '이영희', phone: '01098765432', amount: 120000, merchant: '쿠팡 파트너스', status: '접수', details: '금액을 잘못 입력했습니다.' },
            { code: 'REQ-260220-E5F6', name: '박지성', phone: '01055554444', amount: 3500, merchant: '배달의민족', status: '완료', details: '결제 취소 건 반환 요청' },
            { code: 'REQ-260220-G7H8', name: '최강희', phone: '01011112222', amount: 2000000, merchant: '애플스토어', status: '반려', details: '증빙 서류 미비로 인한 재신청 건' },
            { code: 'REQ-260219-I9J0', name: '한소희', phone: '01033337777', amount: 45000, merchant: '스타벅스 홍대점', status: '완료', details: '포인트 충전 오류' },
            { code: 'REQ-260219-K1L2', name: '정해인', phone: '01088889999', amount: 15000, merchant: '네이버쇼핑', status: '대기', details: '주문 취소 후 미반환' },
            { code: 'REQ-260218-M3N4', name: '강동원', phone: '01022223333', amount: 89000, merchant: '마켓컬리', status: '접수', details: '중복 결제 발생' },
            { code: 'REQ-260218-O5P6', name: '전지현', phone: '01044445555', amount: 330000, merchant: '스타벅스 강남점', status: '대기', details: '계좌 이체 실수' },
            { code: 'REQ-260217-Q7R8', name: '원빈', phone: '01066667777', amount: 12500, merchant: '쿠팡 파트너스', status: '완료', details: '반품 택배비 오입금' },
            { code: 'REQ-260217-S9T0', name: '장동건', phone: '01000001111', amount: 500000, merchant: '배달의민족', status: '접수', details: '기업 결제 오류' }
        ];

        for (const item of sampleData) {
            await pool.request()
                .input('requestCode', mssql.NVarChar, item.code)
                .input('requestDate', mssql.Date, new Date())
                .input('depositDate', mssql.Date, new Date())
                .input('depositAmount', mssql.Decimal, item.amount)
                .input('bankName', mssql.NVarChar, '신한은행')
                .input('userAccount', mssql.NVarChar, '110123456789')
                .input('userAccountName', mssql.NVarChar, item.name)
                .input('contractor_code', mssql.NVarChar, '일반계약')
                .input('merchant_code', mssql.NVarChar, item.merchant)
                .input('applicantName', mssql.NVarChar, item.name)
                .input('applicantPhone', mssql.NVarChar, item.phone)
                .input('details', mssql.NVarChar, item.details)
                .input('idCardFile', mssql.NVarChar, null)
                .input('status', mssql.NVarChar, item.status)
                .query(`IF NOT EXISTS (SELECT 1 FROM Requests WHERE request_code = @requestCode)
                        INSERT INTO Requests (request_code, request_date, deposit_date, deposit_amount, bank_name, user_account, user_account_name, contractor_code, merchant_code, applicant_name, applicant_phone, details, id_card_file, status)
                        VALUES (@requestCode, @requestDate, @depositDate, @depositAmount, @bankName, @userAccount, @userAccountName, @contractor_code, @merchant_code, @applicantName, @applicantPhone, @details, @idCardFile, @status)`);
        }

        console.log('✅ 10 sample records inserted successfully!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Seeding Failed:', err);
        process.exit(1);
    }
}

seedData();
