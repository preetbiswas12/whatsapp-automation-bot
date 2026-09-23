// PM2 ecosystem file — production process management (optional).
//
// Usage:
//   npx pm2 start ecosystem.config.js
//   npx pm2 logs waa-ai-bot
//   npx pm2 save && npx pm2 startup
//
// The API token should live in the environment, not in config.json.

module.exports = {
  apps: [
    {
      name: 'waa-ai-bot',
      script: 'bot.js',
      cwd: __dirname,
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      restart_delay: 3000,
      max_restarts: 20,
      time: true,
      env: {
        NODE_ENV: 'production',
        WAA_BOT_PORT: process.env.WAA_BOT_PORT || '3001',
      },
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      merge_logs: true,
      kill_timeout: 8000,
    },
  ],
};