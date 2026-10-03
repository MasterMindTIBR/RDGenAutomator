/**
 * Host-managed production processes. Start with:
 *   pm2 start ecosystem.config.cjs --env production
 * Runtime secrets stay in the repository-root .env; API and worker load it
 * themselves via @rdgen/domain. The web start command reads PORT, so this file reads the
 * same .env to bridge WEB_PORT into PORT for the web process. Parsing is
 * minimal on purpose: pnpm does not hoist dotenv to the workspace root.
 */
const { readFileSync } = require('node:fs');

for (const line of readFileSync(__dirname + '/.env', 'utf8').split('\n')) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
}

module.exports = {
  apps: [
    {
      name: 'rdgen-web',
      cwd: __dirname,
      script: 'pnpm',
      args: '--filter @rdgen/web start',
      interpreter: 'none',
      instances: 1,
      autorestart: true,
      env_production: {
        NODE_ENV: 'production',
        APP_BIND_HOST: '127.0.0.1',
        PORT: process.env.WEB_PORT || '3000'
      }
    },
    {
      name: 'rdgen-api',
      cwd: __dirname,
      script: 'pnpm',
      args: '--filter @rdgen/api start',
      interpreter: 'none',
      instances: 1,
      autorestart: true,
      env_production: {
        NODE_ENV: 'production',
        APP_BIND_HOST: '127.0.0.1'
      }
    },
    {
      name: 'rdgen-worker',
      cwd: __dirname,
      script: 'pnpm',
      args: '--filter @rdgen/worker start',
      interpreter: 'none',
      instances: 1,
      autorestart: true,
      env_production: {
        NODE_ENV: 'production',
        APP_BIND_HOST: '127.0.0.1'
      }
    }
  ]
};
