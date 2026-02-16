module.exports = {
  apps: [
    // 기존 단일 유저 모드 (main.js)
    {
      name: 'trading-bot',
      script: 'main.js',
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 5000,
      max_restarts: 50,
    },
    // 멀티유저 모드 (multi-launcher.js)
    {
      name: 'trading-bot-multi',
      script: 'multi-launcher.js',
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/pm2-multi-error.log',
      out_file: './logs/pm2-multi-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 5000,
      max_restarts: 50,
    },
  ],
};
