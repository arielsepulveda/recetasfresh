// Ordered SQLite schema migrations for mutable application data.
function runStatements(db, statements, callback) {
  function runNext(index) {
    if (index >= statements.length) {
      return callback();
    }

    db.run(statements[index], (err) => {
      if (err) return callback(err);
      runNext(index + 1);
    });
  }

  runNext(0);
}

function ensureMigrationTable(db, callback) {
  db.run(
    'CREATE TABLE IF NOT EXISTS schema_migration (id TEXT PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL)',
    callback
  );
}

function ensureUserAuthColumns(db, callback) {
  db.all('PRAGMA table_info("user")', [], (err, columns) => {
    if (err) return callback(err);

    const columnNames = new Set((columns || []).map((column) => column.name));
    const statements = [];
    if (!columnNames.has('password_hash')) {
      statements.push('ALTER TABLE "user" ADD COLUMN password_hash TEXT');
    }
    if (!columnNames.has('role')) {
      statements.push('ALTER TABLE "user" ADD COLUMN role TEXT DEFAULT "user"');
    }

    runStatements(db, statements, callback);
  });
}

const APP_MIGRATIONS = [
  {
    id: '001-app-core-schema',
    description: 'Create core app tables for users, favorites, settings, and cart',
    run(db, callback) {
      runStatements(
        db,
        [
          'CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL)',
          'CREATE TABLE IF NOT EXISTS favorite (id TEXT PRIMARY KEY, user_id TEXT, recipe_id TEXT, added_at TEXT, UNIQUE(user_id, recipe_id))',
          'CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT PRIMARY KEY, theme TEXT DEFAULT "light", language TEXT DEFAULT "es", notifications_enabled INTEGER DEFAULT 1)',
          'CREATE TABLE IF NOT EXISTS cart (id TEXT PRIMARY KEY, user_id TEXT, recipe_id TEXT, servings INTEGER, added_at TEXT)',
          'CREATE INDEX IF NOT EXISTS idx_cart_user ON cart(user_id)',
          'CREATE INDEX IF NOT EXISTS idx_cart_recipe ON cart(recipe_id)',
          'CREATE INDEX IF NOT EXISTS idx_favorite_user ON favorite(user_id)',
          'CREATE INDEX IF NOT EXISTS idx_favorite_recipe ON favorite(recipe_id)',
        ],
        callback
      );
    },
  },
  {
    id: '002-user-auth-schema',
    description: 'Add auth columns and unique email index to user table',
    run(db, callback) {
      ensureUserAuthColumns(db, (err) => {
        if (err) return callback(err);

        runStatements(
          db,
          ['CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email ON "user"(email)'],
          callback
        );
      });
    },
  },
  {
    id: '003-invite-schema',
    description: 'Create invite table and indexes',
    run(db, callback) {
      runStatements(
        db,
        [
          'CREATE TABLE IF NOT EXISTS invite (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, email TEXT, max_uses INTEGER NOT NULL DEFAULT 1, use_count INTEGER NOT NULL DEFAULT 0, created_by_user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT)',
          'CREATE INDEX IF NOT EXISTS idx_invite_creator ON invite(created_by_user_id)',
          'CREATE INDEX IF NOT EXISTS idx_invite_email ON invite(email)',
        ],
        callback
      );
    },
  },
  {
    id: '004-archived-cart-schema',
    description: 'Create archived cart tables and indexes',
    run(db, callback) {
      runStatements(
        db,
        [
          'CREATE TABLE IF NOT EXISTS archived_cart (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT NOT NULL)',
          'CREATE TABLE IF NOT EXISTS archived_cart_item (id TEXT PRIMARY KEY, archived_cart_id TEXT NOT NULL, recipe_id TEXT NOT NULL, servings INTEGER NOT NULL DEFAULT 2, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)',
          'CREATE INDEX IF NOT EXISTS idx_archived_cart_user ON archived_cart(user_id)',
          'CREATE INDEX IF NOT EXISTS idx_archived_cart_archived_at ON archived_cart(archived_at)',
          'CREATE INDEX IF NOT EXISTS idx_archived_cart_item_cart ON archived_cart_item(archived_cart_id)',
          'CREATE INDEX IF NOT EXISTS idx_archived_cart_item_recipe ON archived_cart_item(recipe_id)',
        ],
        callback
      );
    },
  },
];

function recordMigration(db, migration, callback) {
  db.run(
    'INSERT INTO schema_migration (id, description, applied_at) VALUES (?, ?, ?)',
    [migration.id, migration.description, new Date().toISOString()],
    callback
  );
}

function runAppMigrations(db, callback) {
  ensureMigrationTable(db, (err) => {
    if (err) return callback(err);

    db.all('SELECT id FROM schema_migration ORDER BY id', [], (selectErr, rows) => {
      if (selectErr) return callback(selectErr);

      const applied = new Set((rows || []).map((row) => row.id));
      const pending = APP_MIGRATIONS.filter((migration) => !applied.has(migration.id));

      function runNext(index) {
        if (index >= pending.length) {
          return callback(null, { pendingCount: pending.length, appliedIds: APP_MIGRATIONS.map((migration) => migration.id) });
        }

        const migration = pending[index];
        migration.run(db, (migrationErr) => {
          if (migrationErr) return callback(migrationErr);

          recordMigration(db, migration, (recordErr) => {
            if (recordErr) return callback(recordErr);
            runNext(index + 1);
          });
        });
      }

      runNext(0);
    });
  });
}

module.exports = {
  runAppMigrations,
};