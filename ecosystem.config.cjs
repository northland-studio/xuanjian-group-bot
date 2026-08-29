/**
 * PM2 进程配置（生产环境）
 * 用法：
 *   pm2 start ecosystem.config.cjs --only xuanjian-group-bot
 *   pm2 save
 *   pm2 logs xuanjian-group-bot
 */
module.exports = {
  apps: [
    {
      name: 'xuanjian-group-bot',
      script: 'dist/index.js',
      cwd: '/var/www/xuanjian-group-bot',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
      },
      out_file: '/var/log/xuanjian-group-bot.out.log',
      error_file: '/var/log/xuanjian-group-bot.err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
