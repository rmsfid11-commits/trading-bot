module.exports = {
  apps: [{
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
  }],
};
