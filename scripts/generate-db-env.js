// Local wrapper that sets environment defaults and then launches crawler/generate-db.js.
const { spawn } = require('child_process');
const path = require('path');

function normalizeEnvName(value) {
  const normalized = (value || 'development').toLowerCase();
  return normalized === 'prod' ? 'production' : normalized;
}

const appEnv = normalizeEnvName(process.argv[2]);
const forwardedArgs = process.argv.slice(3);
const env = {
  ...process.env,
  APP_ENV: appEnv,
};

if (!env.CATALOG_DB_FILE) {
  env.CATALOG_DB_FILE = path.join(__dirname, '..', 'data', 'recipes.db');
}

const child = spawn(process.execPath, [path.join(__dirname, '..', 'crawler', 'generate-db.js'), ...forwardedArgs], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code) => {
  process.exit(code || 0);
});