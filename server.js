// Runtime API server for the recipe app, including auth, sessions, and user data.
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const SQLiteStoreFactory = require('connect-sqlite3');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const { runAppMigrations } = require('./app-migrations');
const {
  APP_ENV,
  PORT,
  JSON_DIR,
  CATALOG_DB_FILE,
  APP_DB_FILE,
  SESSION_DB_FILE,
  ADMIN_EMAILS,
  ALLOW_PUBLIC_REGISTRATION,
  INVITE_DEFAULT_MAX_USES,
  INVITE_DEFAULT_EXPIRES_IN_DAYS,
} = require('./config');

const app = express();
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret';
const SQLiteStore = SQLiteStoreFactory(session);

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(
  session({
    name: 'recetas.sid',
    secret: SESSION_SECRET,
    store: new SQLiteStore({
      db: path.basename(SESSION_DB_FILE),
      dir: path.dirname(SESSION_DB_FILE),
      table: 'sessions',
      concurrentDB: true,
    }),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // In production, use secure cookies only when the request is actually HTTPS.
      secure: APP_ENV === 'production' ? 'auto' : false,
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
  })
);

app.use('/images', express.static(path.join(__dirname, 'images')));
app.use('/pdf', express.static(path.join(__dirname, 'pdf')));
app.use('/json', express.static(JSON_DIR));
app.use('/', express.static(path.join(__dirname, 'public')));

let recipeCache = [];

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role || 'user',
    created_at: row.created_at,
  };
}

function isConfiguredAdminEmail(email) {
  return ADMIN_EMAILS.includes(normalizeEmail(email));
}

function applyRole(row) {
  if (!row) return null;
  const normalized = { ...row };
  normalized.role = normalized.role || 'user';
  if (isConfiguredAdminEmail(normalized.email)) {
    normalized.role = 'admin';
  }
  return normalized;
}

function buildInviteUrl(req, token) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  return `${protocol}://${req.get('host')}/?invite=${encodeURIComponent(token)}`;
}

function loadJsonRecipes() {
  if (!fs.existsSync(JSON_DIR)) {
    console.warn(`JSON directory not found: ${JSON_DIR}`);
    recipeCache = [];
    return;
  }

  const fileNames = fs.readdirSync(JSON_DIR).filter((fileName) => fileName.endsWith('.json'));
  recipeCache = fileNames.map((fileName) => {
    const raw = fs.readFileSync(path.join(JSON_DIR, fileName), 'utf8');
    const recipe = JSON.parse(raw);
    recipe._friendlyId = recipe.id || recipe.uuid || recipe.name;
    return recipe;
  });
  console.log(`Loaded ${recipeCache.length} recipes into memory`);
}

function openCatalogDb(mode = sqlite3.OPEN_READONLY) {
  return new sqlite3.Database(CATALOG_DB_FILE, mode);
}

function openAppDb(mode = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE) {
  return new sqlite3.Database(APP_DB_FILE, mode);
}

function applyRecipeFilters(recipes, query) {
  const q = (query.q || '').toString().toLowerCase();
  const difficulty = Number(query.difficulty || 0);
  const maxTime = Number(query.maxTime || 0);
  const cuisine = (query.cuisine || '').toString().toLowerCase();
  const country = (query.country || '').toString().toLowerCase();

  let results = [...recipes];

  if (q) {
    results = results.filter((recipe) => {
      const haystack = (recipe.name + ' ' + recipe.description + ' ' + (recipe.headline || '') + ' ' + (recipe.slug || '')).toLowerCase();
      return haystack.includes(q);
    });
  }

  if (difficulty > 0) {
    results = results.filter((recipe) => Number(recipe.difficulty) === difficulty);
  }

  if (maxTime > 0) {
    results = results.filter((recipe) => {
      if (!recipe.totalTime) return true;
      const match = recipe.totalTime.match(/PT(\d+)M/);
      if (!match) return true;
      return Number(match[1]) <= maxTime;
    });
  }

  if (cuisine) {
    results = results.filter((recipe) => {
      if (!Array.isArray(recipe.cuisines)) return false;
      return recipe.cuisines.some((entry) => (entry.name || entry.type || '').toLowerCase().includes(cuisine));
    });
  }

  if (country) {
    results = results.filter((recipe) => (recipe.country || '').toLowerCase() === country);
  }

  return results;
}

function buildCartItemsFromRows(cartRows, callback) {
  const rows = cartRows || [];
  const recipeIds = rows.map((row) => row.recipe_id);
  fetchCatalogRecipeRows(recipeIds, (catalogErr, recipeRows) => {
    if (catalogErr) return callback(catalogErr);

    const recipesById = new Map(recipeRows.map((row) => [row.id, JSON.parse(row.json)]));
    const items = rows
      .map((row) => {
        const recipe = recipesById.get(row.recipe_id);
        if (!recipe) return null;

        return {
          id: row.id,
          recipeId: row.recipe_id,
          servings: Number(row.servings) || 2,
          addedAt: row.added_at,
          recipe,
        };
      })
      .filter(Boolean);

    callback(null, items);
  });
}

function getDefaultArchivedCartName() {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = String(now.getFullYear());
  return `Cart ${day}-${month}-${year}`;
}

function getBootstrapAdminAvailable(callback) {
  if (ADMIN_EMAILS.length === 0) return callback(null, false);

  const placeholders = ADMIN_EMAILS.map(() => '?').join(', ');
  const db = openAppDb(sqlite3.OPEN_READONLY);
  db.get(`SELECT COUNT(*) AS count FROM "user" WHERE email IN (${placeholders})`, ADMIN_EMAILS, (err, row) => {
    db.close();
    if (err) return callback(err);
    callback(null, Number(row && row.count) === 0);
  });
}

function getUserById(userId, callback) {
  const db = openAppDb(sqlite3.OPEN_READONLY);
  db.get('SELECT id, name, email, password_hash, role, created_at FROM "user" WHERE id = ? LIMIT 1', [userId], (err, row) => {
    db.close();
    callback(err, applyRole(row || null));
  });
}

function getUserByEmail(email, callback) {
  const db = openAppDb(sqlite3.OPEN_READONLY);
  db.get('SELECT id, name, email, password_hash, role, created_at FROM "user" WHERE email = ? LIMIT 1', [normalizeEmail(email)], (err, row) => {
    db.close();
    callback(err, applyRole(row || null));
  });
}

function attachAuthenticatedUser(req, res, next) {
  const sessionUserId = req.session && req.session.userId;
  if (!sessionUserId) {
    req.currentUser = null;
    return next();
  }

  getUserById(sessionUserId, (err, user) => {
    if (err) return next(err);
    if (!user && req.session) {
      delete req.session.userId;
    }
    req.currentUser = user || null;
    next();
  });
}

function requireAuth(req, res, next) {
  if (!req.currentUser) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.currentUser || req.currentUser.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function fetchCatalogRecipeRows(recipeIds, callback) {
  if (!fs.existsSync(CATALOG_DB_FILE)) {
    return callback(new Error('Catalog database not found'));
  }
  if (!Array.isArray(recipeIds) || recipeIds.length === 0) {
    return callback(null, []);
  }

  const placeholders = recipeIds.map(() => '?').join(', ');
  const db = openCatalogDb();
  db.all(`SELECT id, json FROM recipe WHERE id IN (${placeholders})`, recipeIds, (err, rows) => {
    db.close();
    callback(err, rows || []);
  });
}

function fetchCatalogRecipeById(recipeId, callback) {
  if (!fs.existsSync(CATALOG_DB_FILE)) {
    return callback(new Error('Catalog database not found'));
  }

  const db = openCatalogDb();
  db.get('SELECT id, json FROM recipe WHERE id = ? LIMIT 1', [recipeId], (err, row) => {
    db.close();
    callback(err, row || null);
  });
}

function establishSession(req, userId, callback) {
  req.session.regenerate((err) => {
    if (err) return callback(err);
    req.session.userId = userId;
    callback();
  });
}

function hashInviteToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function validateInviteToken(token, email, callback) {
  const tokenHash = hashInviteToken(token);
  const nowIso = new Date().toISOString();
  const db = openAppDb();
  db.get(
    'SELECT id, email, max_uses, use_count, expires_at, revoked_at FROM invite WHERE token_hash = ? LIMIT 1',
    [tokenHash],
    (err, invite) => {
      if (err) {
        db.close();
        return callback(err);
      }
      if (!invite) {
        db.close();
        return callback(new Error('Invitation not found'));
      }
      if (invite.revoked_at) {
        db.close();
        return callback(new Error('Invitation revoked'));
      }
      if (invite.expires_at && invite.expires_at <= nowIso) {
        db.close();
        return callback(new Error('Invitation expired'));
      }
      if (Number(invite.use_count || 0) >= Number(invite.max_uses || 0)) {
        db.close();
        return callback(new Error('Invitation fully used'));
      }
      if (invite.email && normalizeEmail(invite.email) !== normalizeEmail(email)) {
        db.close();
        return callback(new Error('Invitation email does not match'));
      }

      db.close();
      callback(null, invite);
    }
  );
}

function consumeInvite(inviteId, callback) {
  const nowIso = new Date().toISOString();
  const db = openAppDb();
  db.run(
    'UPDATE invite SET use_count = use_count + 1 WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND use_count < max_uses',
    [inviteId, nowIso],
    function onUpdate(err) {
      db.close();
      if (err) return callback(err);
      if (this.changes !== 1) return callback(new Error('Invitation could not be consumed'));
      callback();
    }
  );
}

loadJsonRecipes();
app.use(attachAuthenticatedUser);

app.get('/api/recipes', (req, res) => {
  const results = applyRecipeFilters(recipeCache, req.query);

  const limit = Math.min(Number(req.query.limit || 50), 500);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const paged = results.slice(offset, offset + limit);

  res.json({ total: results.length, offset, limit, recipes: paged });
});

app.get('/api/recipes/:id', (req, res) => {
  const recipe = recipeCache.find((entry) => entry.id === req.params.id || entry.uuid === req.params.id || entry._friendlyId === req.params.id);
  if (!recipe) {
    return res.status(404).json({ error: 'Recipe not found' });
  }
  res.json(recipe);
});

app.get('/api/db/recipes', (req, res) => {
  if (!fs.existsSync(CATALOG_DB_FILE)) {
    return res.status(404).json({ error: 'Database file not found. Run npm run generate-db.' });
  }

  const db = openCatalogDb();
  const q = req.query.q || '';
  const sql = q
    ? 'SELECT id, name, slug, description, difficulty, prepTime, totalTime, servings, imageLink, localImage, cardLink, localCard, country, averageRating FROM recipe WHERE LOWER(name) LIKE ? OR LOWER(description) LIKE ? LIMIT 500'
    : 'SELECT id, name, slug, description, difficulty, prepTime, totalTime, servings, imageLink, localImage, cardLink, localCard, country, averageRating FROM recipe LIMIT 500';
  const params = q ? [`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`] : [];

  db.all(sql, params, (err, rows) => {
    db.close();
    if (err) return res.status(500).json({ error: err.message });
    res.json({ total: rows.length, recipes: rows });
  });
});

app.get('/api/db/recipes/:id', (req, res) => {
  if (!fs.existsSync(CATALOG_DB_FILE)) {
    return res.status(404).json({ error: 'Database file not found. Run npm run generate-db.' });
  }

  const db = openCatalogDb();
  db.get('SELECT json FROM recipe WHERE id = ? OR slug = ? LIMIT 1', [req.params.id, req.params.id], (err, row) => {
    db.close();
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Recipe not found' });
    res.json(JSON.parse(row.json));
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    recipes: recipeCache.length,
    catalogDb: CATALOG_DB_FILE,
    appDb: APP_DB_FILE,
    allowRegistration: ALLOW_PUBLIC_REGISTRATION,
  });
});

app.get('/api/auth/session', (req, res) => {
  getBootstrapAdminAvailable((err, bootstrapAdminAvailable) => {
    if (err) return res.status(500).json({ error: err.message });

    res.json({
      authenticated: !!req.currentUser,
      user: sanitizeUser(req.currentUser),
      allowRegistration: ALLOW_PUBLIC_REGISTRATION,
      bootstrapAdminAvailable,
      inviteDefaults: {
        maxUses: INVITE_DEFAULT_MAX_USES,
        expiresInDays: INVITE_DEFAULT_EXPIRES_IN_DAYS,
      },
    });
  });
});

app.post('/api/auth/register', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const inviteToken = String(req.body.inviteToken || '').trim();
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  getBootstrapAdminAvailable((bootstrapErr, bootstrapAdminAvailable) => {
    if (bootstrapErr) return res.status(500).json({ error: bootstrapErr.message });

    const canBootstrapAdmin = bootstrapAdminAvailable && isConfiguredAdminEmail(email);
    const requiresInvite = !ALLOW_PUBLIC_REGISTRATION && !canBootstrapAdmin;

    const proceedWithInvite = (inviteErr, inviteRecord) => {
      if (inviteErr) {
        return res.status(403).json({ error: inviteErr.message });
      }

      getUserByEmail(email, (lookupErr, existingUser) => {
        if (lookupErr) return res.status(500).json({ error: lookupErr.message });
        if (existingUser) return res.status(409).json({ error: 'Email already registered' });

        const userId = crypto.randomUUID();
        const passwordHash = bcrypt.hashSync(password, 10);
        const createdAt = new Date().toISOString();
        const role = isConfiguredAdminEmail(email) ? 'admin' : 'user';
        const db = openAppDb();
        db.run(
          'INSERT INTO "user" (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [userId, name, email, passwordHash, role, createdAt],
          (insertErr) => {
            if (insertErr) {
              db.close();
              return res.status(500).json({ error: insertErr.message });
            }

            db.run('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)', [userId], (settingsErr) => {
              if (settingsErr) {
                db.close();
                return res.status(500).json({ error: settingsErr.message });
              }

              const finish = () => {
                db.close();
                establishSession(req, userId, (sessionErr) => {
                  if (sessionErr) return res.status(500).json({ error: sessionErr.message });
                  res.status(201).json({ user: { id: userId, name, email, role, created_at: createdAt } });
                });
              };

              if (!inviteRecord) {
                return finish();
              }

              consumeInvite(inviteRecord.id, (consumeErr) => {
                if (consumeErr) {
                  db.close();
                  return res.status(500).json({ error: consumeErr.message });
                }
                finish();
              });
            });
          }
        );
      });
    };

    if (!requiresInvite) {
      return proceedWithInvite(null, null);
    }

    if (!inviteToken) {
      return res.status(403).json({ error: 'Invitation required' });
    }

    validateInviteToken(inviteToken, email, proceedWithInvite);
  });
});

app.post('/api/auth/login', (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  getUserByEmail(email, (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    establishSession(req, user.id, (sessionErr) => {
      if (sessionErr) return res.status(500).json({ error: sessionErr.message });
      res.json({ user: sanitizeUser(user) });
    });
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.clearCookie('recetas.sid');
    res.json({ success: true });
  });
});

app.get('/api/admin/invites', requireAuth, requireAdmin, (req, res) => {
  const db = openAppDb(sqlite3.OPEN_READONLY);
  db.all(
    'SELECT id, email, max_uses, use_count, created_at, expires_at, revoked_at FROM invite WHERE created_by_user_id = ? ORDER BY created_at DESC',
    [req.currentUser.id],
    (err, rows) => {
      db.close();
      if (err) return res.status(500).json({ error: err.message });
      res.json({ invites: rows || [] });
    }
  );
});

app.post('/api/admin/invites', requireAuth, requireAdmin, (req, res) => {
  const email = req.body.email ? normalizeEmail(req.body.email) : null;
  const maxUses = Math.max(Number(req.body.maxUses || INVITE_DEFAULT_MAX_USES), 1);
  const expiresInDays = Math.max(Number(req.body.expiresInDays || INVITE_DEFAULT_EXPIRES_IN_DAYS), 1);
  const inviteId = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString('hex');
  const tokenHash = hashInviteToken(token);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();

  const db = openAppDb();
  db.run(
    'INSERT INTO invite (id, token_hash, email, max_uses, use_count, created_by_user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL)',
    [inviteId, tokenHash, email, maxUses, req.currentUser.id, createdAt, expiresAt],
    (err) => {
      db.close();
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({
        invite: {
          id: inviteId,
          email,
          max_uses: maxUses,
          use_count: 0,
          created_at: createdAt,
          expires_at: expiresAt,
          revoked_at: null,
        },
        inviteUrl: buildInviteUrl(req, token),
        token,
      });
    }
  );
});

app.delete('/api/admin/invites/:inviteId', requireAuth, requireAdmin, (req, res) => {
  const inviteId = String(req.params.inviteId || '').trim();
  if (!inviteId) {
    return res.status(400).json({ error: 'Invite id is required' });
  }

  const db = openAppDb();
  db.run(
    'DELETE FROM invite WHERE id = ? AND created_by_user_id = ?',
    [inviteId, req.currentUser.id],
    function onDelete(err) {
      db.close();
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes !== 1) {
        return res.status(404).json({ error: 'Invitation not found' });
      }
      res.json({ success: true, id: inviteId });
    }
  );
});

app.get('/api/user/profile', requireAuth, (req, res) => {
  res.json(sanitizeUser(req.currentUser));
});

app.post('/api/user/profile', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });

  const db = openAppDb();
  db.run('UPDATE "user" SET name = ? WHERE id = ?', [name, req.currentUser.id], (err) => {
    db.close();
    if (err) return res.status(500).json({ error: err.message });
    res.json({
      id: req.currentUser.id,
      name,
      email: req.currentUser.email,
      role: req.currentUser.role,
      created_at: req.currentUser.created_at,
    });
  });
});

app.get('/api/user/favorites', requireAuth, (req, res) => {
  if (!fs.existsSync(CATALOG_DB_FILE)) {
    return res.status(404).json({ error: 'Catalog database not found' });
  }

  const db = openAppDb(sqlite3.OPEN_READONLY);
  db.all('SELECT recipe_id, added_at FROM favorite WHERE user_id = ? ORDER BY added_at DESC', [req.currentUser.id], (err, rows) => {
    db.close();
    if (err) return res.status(500).json({ error: err.message });

    const recipeIds = (rows || []).map((row) => row.recipe_id);
    fetchCatalogRecipeRows(recipeIds, (catalogErr, recipeRows) => {
      if (catalogErr) return res.status(500).json({ error: catalogErr.message });

      const recipesById = new Map(recipeRows.map((row) => [row.id, JSON.parse(row.json)]));
      const recipes = recipeIds.map((recipeId) => recipesById.get(recipeId)).filter(Boolean);
      const filtered = applyRecipeFilters(recipes, req.query);
      res.json({ total: filtered.length, recipes: filtered });
    });
  });
});

app.post('/api/user/favorites/:recipeId', requireAuth, (req, res) => {
  if (!fs.existsSync(CATALOG_DB_FILE)) {
    return res.status(404).json({ error: 'Catalog database not found' });
  }

  const recipeId = req.params.recipeId;
  fetchCatalogRecipeById(recipeId, (recipeErr, recipeRow) => {
    if (recipeErr) return res.status(500).json({ error: recipeErr.message });
    if (!recipeRow) return res.status(404).json({ error: 'Recipe not found' });

    const db = openAppDb();
    const favoriteId = `fav-${req.currentUser.id}-${recipeId}-${Date.now()}`;
    db.run(
      'INSERT OR IGNORE INTO favorite (id, user_id, recipe_id, added_at) VALUES (?, ?, ?, ?)',
      [favoriteId, req.currentUser.id, recipeId, new Date().toISOString()],
      (insertErr) => {
        db.close();
        if (insertErr) return res.status(500).json({ error: insertErr.message });
        res.json({ success: true, recipeId });
      }
    );
  });
});

app.delete('/api/user/favorites/:recipeId', requireAuth, (req, res) => {
  const db = openAppDb();
  db.run('DELETE FROM favorite WHERE user_id = ? AND recipe_id = ?', [req.currentUser.id, req.params.recipeId], (err) => {
    db.close();
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, recipeId: req.params.recipeId });
  });
});

app.get('/api/user/favorites/:recipeId/check', requireAuth, (req, res) => {
  const db = openAppDb(sqlite3.OPEN_READONLY);
  db.get('SELECT id FROM favorite WHERE user_id = ? AND recipe_id = ? LIMIT 1', [req.currentUser.id, req.params.recipeId], (err, row) => {
    db.close();
    if (err) return res.status(500).json({ error: err.message, isFavorite: false });
    res.json({ isFavorite: !!row });
  });
});

app.get('/api/user/cart', requireAuth, (req, res) => {
  if (!fs.existsSync(CATALOG_DB_FILE)) {
    return res.status(404).json({ error: 'Catalog database not found' });
  }

  const db = openAppDb(sqlite3.OPEN_READONLY);
  db.all('SELECT id, recipe_id, servings, added_at FROM cart WHERE user_id = ? ORDER BY added_at DESC', [req.currentUser.id], (queryErr, rows) => {
    db.close();
    if (queryErr) return res.status(500).json({ error: queryErr.message });

    buildCartItemsFromRows(rows || [], (catalogErr, items) => {
      if (catalogErr) return res.status(500).json({ error: catalogErr.message });
      res.json({ total: items.length, items });
    });
  });
});

app.get('/api/user/archived-carts', requireAuth, (req, res) => {
  const db = openAppDb(sqlite3.OPEN_READONLY);
  db.all(
    'SELECT ac.id, ac.name, ac.created_at, ac.archived_at, COUNT(aci.id) AS item_count FROM archived_cart ac LEFT JOIN archived_cart_item aci ON ac.id = aci.archived_cart_id WHERE ac.user_id = ? GROUP BY ac.id ORDER BY ac.archived_at DESC',
    [req.currentUser.id],
    (err, rows) => {
      db.close();
      if (err) return res.status(500).json({ error: err.message });
      const carts = (rows || []).map((row) => ({
        id: row.id,
        name: row.name,
        created_at: row.created_at,
        archived_at: row.archived_at,
        item_count: Number(row.item_count) || 0,
      }));
      res.json({ total: carts.length, carts });
    }
  );
});

app.post('/api/user/archived-carts', requireAuth, (req, res) => {
  const requestedName = String(req.body.name || '').trim();
  const archiveName = requestedName || getDefaultArchivedCartName();
  const nowIso = new Date().toISOString();
  const db = openAppDb();

  db.all('SELECT recipe_id, servings, added_at FROM cart WHERE user_id = ? ORDER BY added_at DESC', [req.currentUser.id], (selectErr, rows) => {
    if (selectErr) {
      db.close();
      return res.status(500).json({ error: selectErr.message });
    }

    const cartRows = rows || [];
    if (cartRows.length === 0) {
      db.close();
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const archivedCartId = crypto.randomUUID();
    let failed = false;

    const rollbackAndClose = (message, status = 500) => {
      db.run('ROLLBACK', () => {
        db.close();
        res.status(status).json({ error: message });
      });
    };

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run(
        'INSERT INTO archived_cart (id, user_id, name, created_at, archived_at) VALUES (?, ?, ?, ?, ?)',
        [archivedCartId, req.currentUser.id, archiveName, nowIso, nowIso],
        (insertCartErr) => {
          if (insertCartErr && !failed) {
            failed = true;
            rollbackAndClose(insertCartErr.message);
          }
        }
      );

      cartRows.forEach((row, index) => {
        db.run(
          'INSERT INTO archived_cart_item (id, archived_cart_id, recipe_id, servings, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [crypto.randomUUID(), archivedCartId, row.recipe_id, Number(row.servings) || 2, index, row.added_at || nowIso],
          (insertItemErr) => {
            if (insertItemErr && !failed) {
              failed = true;
              rollbackAndClose(insertItemErr.message);
            }
          }
        );
      });

      db.run('COMMIT', (commitErr) => {
        if (failed) return;
        if (commitErr) {
          return rollbackAndClose(commitErr.message);
        }

        db.close();
        res.status(201).json({
          cart: {
            id: archivedCartId,
            name: archiveName,
            created_at: nowIso,
            archived_at: nowIso,
            item_count: cartRows.length,
          },
        });
      });
    });
  });
});

app.post('/api/user/archived-carts/:archivedCartId/load', requireAuth, (req, res) => {
  if (!fs.existsSync(CATALOG_DB_FILE)) {
    return res.status(404).json({ error: 'Catalog database not found' });
  }

  const archivedCartId = String(req.params.archivedCartId || '').trim();
  if (!archivedCartId) {
    return res.status(400).json({ error: 'Archived cart id is required' });
  }

  const mode = String(req.body.mode || 'replace').toLowerCase();
  if (!['replace', 'append'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid load mode' });
  }

  const db = openAppDb();
  db.get('SELECT id FROM archived_cart WHERE id = ? AND user_id = ? LIMIT 1', [archivedCartId, req.currentUser.id], (cartErr, cartRow) => {
    if (cartErr) {
      db.close();
      return res.status(500).json({ error: cartErr.message });
    }
    if (!cartRow) {
      db.close();
      return res.status(404).json({ error: 'Archived cart not found' });
    }

    db.all(
      'SELECT recipe_id, servings, created_at FROM archived_cart_item WHERE archived_cart_id = ? ORDER BY position ASC, created_at ASC',
      [archivedCartId],
      (itemsErr, archivedRows) => {
        if (itemsErr) {
          db.close();
          return res.status(500).json({ error: itemsErr.message });
        }

        const rows = archivedRows || [];
        if (rows.length === 0) {
          db.close();
          return res.status(400).json({ error: 'Archived cart has no items' });
        }

        let failed = false;
        const insertedRows = [];

        const rollbackAndClose = (message, status = 500) => {
          db.run('ROLLBACK', () => {
            db.close();
            res.status(status).json({ error: message });
          });
        };

        db.serialize(() => {
          db.run('BEGIN TRANSACTION');

          if (mode === 'replace') {
            db.run('DELETE FROM cart WHERE user_id = ?', [req.currentUser.id], (deleteErr) => {
              if (deleteErr && !failed) {
                failed = true;
                rollbackAndClose(deleteErr.message);
              }
            });
          }

          rows.forEach((row, index) => {
            const cartId = `cart-${req.currentUser.id}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
            const addedAt = new Date(Date.now() + index).toISOString();
            insertedRows.push({ id: cartId, recipe_id: row.recipe_id, servings: Number(row.servings) || 2, added_at: addedAt });
            db.run(
              'INSERT INTO cart (id, user_id, recipe_id, servings, added_at) VALUES (?, ?, ?, ?, ?)',
              [cartId, req.currentUser.id, row.recipe_id, Number(row.servings) || 2, addedAt],
              (insertErr) => {
                if (insertErr && !failed) {
                  failed = true;
                  rollbackAndClose(insertErr.message);
                }
              }
            );
          });

          db.run('COMMIT', (commitErr) => {
            if (failed) return;
            if (commitErr) {
              return rollbackAndClose(commitErr.message);
            }

            db.close();
            buildCartItemsFromRows(insertedRows, (catalogErr, items) => {
              if (catalogErr) return res.status(500).json({ error: catalogErr.message });
              res.json({ success: true, mode, total: items.length, items });
            });
          });
        });
      }
    );
  });
});

app.delete('/api/user/archived-carts/:archivedCartId', requireAuth, (req, res) => {
  const archivedCartId = String(req.params.archivedCartId || '').trim();
  if (!archivedCartId) {
    return res.status(400).json({ error: 'Archived cart id is required' });
  }

  const db = openAppDb();
  let failed = false;

  const rollbackAndClose = (message, status = 500) => {
    db.run('ROLLBACK', () => {
      db.close();
      res.status(status).json({ error: message });
    });
  };

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    db.run('DELETE FROM archived_cart_item WHERE archived_cart_id = ?', [archivedCartId], (deleteItemsErr) => {
      if (deleteItemsErr && !failed) {
        failed = true;
        rollbackAndClose(deleteItemsErr.message);
      }
    });

    db.run('DELETE FROM archived_cart WHERE id = ? AND user_id = ?', [archivedCartId, req.currentUser.id], function onDelete(deleteCartErr) {
      if (deleteCartErr && !failed) {
        failed = true;
        rollbackAndClose(deleteCartErr.message);
        return;
      }

      if (this.changes !== 1 && !failed) {
        failed = true;
        rollbackAndClose('Archived cart not found', 404);
      }
    });

    db.run('COMMIT', (commitErr) => {
      if (failed) return;
      if (commitErr) {
        return rollbackAndClose(commitErr.message);
      }
      db.close();
      res.json({ success: true, id: archivedCartId });
    });
  });
});

app.post('/api/user/cart', requireAuth, (req, res) => {
  if (!fs.existsSync(CATALOG_DB_FILE)) {
    return res.status(404).json({ error: 'Catalog database not found' });
  }

  const recipeId = String(req.body.recipeId || '');
  const servings = Number(req.body.servings || 2);
  if (!recipeId) {
    return res.status(400).json({ error: 'recipeId required' });
  }

  fetchCatalogRecipeById(recipeId, (recipeErr, recipeRow) => {
    if (recipeErr) return res.status(500).json({ error: recipeErr.message });
    if (!recipeRow) return res.status(404).json({ error: 'Recipe not found' });

    const db = openAppDb();
    const cartId = `cart-${req.currentUser.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const addedAt = new Date().toISOString();
    db.run(
      'INSERT INTO cart (id, user_id, recipe_id, servings, added_at) VALUES (?, ?, ?, ?, ?)',
      [cartId, req.currentUser.id, recipeId, servings, addedAt],
      (insertErr) => {
        db.close();
        if (insertErr) return res.status(500).json({ error: insertErr.message });
        res.json({ success: true, item: { id: cartId, recipeId, servings, addedAt } });
      }
    );
  });
});

app.delete('/api/user/cart/:itemId', requireAuth, (req, res) => {
  const db = openAppDb();
  db.run('DELETE FROM cart WHERE id = ? AND user_id = ?', [req.params.itemId, req.currentUser.id], (deleteErr) => {
    db.close();
    if (deleteErr) return res.status(500).json({ error: deleteErr.message });
    res.json({ success: true, itemId: req.params.itemId });
  });
});

app.delete('/api/user/cart', requireAuth, (req, res) => {
  const db = openAppDb();
  db.run('DELETE FROM cart WHERE user_id = ?', [req.currentUser.id], (deleteErr) => {
    db.close();
    if (deleteErr) return res.status(500).json({ error: deleteErr.message });
    res.json({ success: true });
  });
});

const migrationDb = openAppDb();
runAppMigrations(migrationDb, (err, result) => {
  migrationDb.close((closeErr) => {
    if (closeErr) {
      console.error('Error closing migration database:', closeErr.message);
    }

    if (err) {
      console.error('Failed to apply app migrations:', err.message);
      process.exit(1);
    }

    if (result.pendingCount > 0) {
      console.log(`Applied ${result.pendingCount} app migration(s)`);
    }

    app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT} (${APP_ENV})`);
      console.log(`Using catalog database: ${CATALOG_DB_FILE}`);
      console.log(`Using app database: ${APP_DB_FILE}`);
      console.log(`Using session database: ${SESSION_DB_FILE}`);
    });
  });
});
