const fs = require('fs');
const path = require('path');
const { poolPromise, mssql } = require('./db');

async function pushDatabase() {
    console.log('--- Starting Database Push ---');
    try {
        const pool = await poolPromise;
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');

        // Note: mssql can execute multiple statements in one query call 
        // as long as they are valid SQL batches.
        // We'll split by 'GO' if necessary, but our schema is currently blocks.
        
        console.log('Executing schema.sql...');
        await pool.request().batch(schemaSql);
        
        console.log('✅ Database schema applied successfully!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Database Push Failed:', err.message);
        if (err.message.includes('already exists')) {
            console.log('ℹ️ Some objects already exist. If you need to update constraints, please drop the tables manually first.');
        }
        process.exit(1);
    }
}

pushDatabase();
