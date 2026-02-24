const { poolPromise, mssql } = require('./db');
const bcrypt = require('bcrypt');

async function resetAdminPassword() {
    const newPassword = process.argv[2];
    if (!newPassword) {
        console.error('Usage: node src/resetAdminPw.js <new-password>');
        process.exit(1);
    }

    try {
        const hash = await bcrypt.hash(newPassword, 10);
        const pool = await poolPromise;
        const result = await pool.request()
            .input('hash', mssql.NVarChar, hash)
            .input('username', mssql.NVarChar, 'admin')
            .query('UPDATE Users SET password_hash = @hash WHERE username = @username');

        if (result.rowsAffected[0] > 0) {
            console.log('admin password updated successfully.');
        } else {
            console.log('No admin user found. Inserting...');
            await pool.request()
                .input('hash', mssql.NVarChar, hash)
                .query("INSERT INTO Users (username, password_hash, name) VALUES ('admin', @hash, N'시스템관리자')");
            console.log('admin user created.');
        }
        process.exit(0);
    } catch (err) {
        console.error('Failed:', err.message);
        process.exit(1);
    }
}

resetAdminPassword();
