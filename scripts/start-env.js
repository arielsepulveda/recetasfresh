// Local wrapper that sets environment defaults and then launches server.js.
const { spawn } = require('child_process');
const path = require('path');

function normalizeEnvName(value) {
  const normalized = (value || 'development').toLowerCase();
  return normalized === 'prod' ? 'production' : normalized;
}

const appEnv = normalizeEnvName(process.argv[2]);
const env = {
  ...process.env,
  APP_ENV: appEnv,
};

if (!env.PORT) {
  env.PORT = appEnv === 'production' ? '3000' : '3001';
}

if (!env.CATALOG_DB_FILE) {
  env.CATALOG_DB_FILE = path.join(__dirname, '..', 'data', 'recipes.db');
}

if (!env.APP_DB_FILE) {
  env.APP_DB_FILE = path.join(__dirname, '..', 'data', appEnv === 'production' ? 'app.db' : 'app.dev.db');
}

const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code) => {
  process.exit(code || 0);
});