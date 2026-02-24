module.exports = {
  apps: [{
    name: 'reasonsform',
    script: './src/server.js',
    cwd: __dirname,
    node_args: '--disable-proto=throw',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      PORT: 4000
    },
    // 로그 설정
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    // Windows 안정성
    kill_timeout: 5000,
    listen_timeout: 10000
  }]
};
