// Centralized environment and path resolution for runtime and maintenance scripts.
const fs = require('fs');
const path = require('path');

const rawAppEnv = (process.env.APP_ENV || process.env.NODE_ENV || 'production').toLowerCase();
const APP_ENV = rawAppEnv === 'dev' ? 'development' : rawAppEnv;
const IS_DEVELOPMENT = APP_ENV === 'development';
const SETTINGS_FILE = path.join(__dirname, 'app-settings.json');

const defaultSettings = {
  adminEmails: [],
  allowPublicRegistration: false,
  inviteDefaults: {
    maxUses: 1,
    expiresInDays: 7,
  },
};

let appSettings = defaultSettings;
if (fs.existsSync(SETTINGS_FILE)) {
  try {
    const rawSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    appSettings = {
      ...defaultSettings,
      ...rawSettings,
      inviteDefaults: {
        ...defaultSettings.inviteDefaults,
        ...(rawSettings.inviteDefaults || {}),
      },
    };
  } catch (err) {
    console.warn(`Unable to read app settings from ${SETTINGS_FILE}: ${err.message}`);
  }
}

function resolveWorkspacePath(envName, fallbackRelativePath) {
  const configuredPath = process.env[envName];
  return configuredPath ? path.resolve(configuredPath) : path.join(__dirname, fallbackRelativePath);
}

const PORT = Number(process.env.PORT || (IS_DEVELOPMENT ? 3001 : 3000));
const JSON_DIR = resolveWorkspacePath('JSON_DIR', 'crawler/downloads_json');
const CATALOG_DB_FILE = resolveWorkspacePath('CATALOG_DB_FILE', 'data/recipes.db');
const APP_DB_FILE = resolveWorkspacePath(
  'APP_DB_FILE',
  IS_DEVELOPMENT ? 'data/app.dev.db' : 'data/app.db'
);
const SESSION_DB_FILE = resolveWorkspacePath(
  'SESSION_DB_FILE',
  IS_DEVELOPMENT ? 'data/sessions.dev.db' : 'data/sessions.db'
);
const ADMIN_EMAILS = Array.from(new Set((appSettings.adminEmails || []).map((email) => String(email || '').trim().toLowerCase()).filter(Boolean)));
const ALLOW_PUBLIC_REGISTRATION = process.env.ALLOW_REGISTRATION
  ? process.env.ALLOW_REGISTRATION === 'true'
  : !!appSettings.allowPublicRegistration;
const INVITE_DEFAULT_MAX_USES = Math.max(Number(appSettings.inviteDefaults.maxUses || 1), 1);
const INVITE_DEFAULT_EXPIRES_IN_DAYS = Math.max(Number(appSettings.inviteDefaults.expiresInDays || 7), 1);

module.exports = {
  APP_ENV,
  IS_DEVELOPMENT,
  PORT,
  JSON_DIR,
  CATALOG_DB_FILE,
  APP_DB_FILE,
  SESSION_DB_FILE,
  ADMIN_EMAILS,
  ALLOW_PUBLIC_REGISTRATION,
  INVITE_DEFAULT_MAX_USES,
  INVITE_DEFAULT_EXPIRES_IN_DAYS,
  SETTINGS_FILE,
};