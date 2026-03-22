// Builds or refreshes the catalog SQLite database from the crawled JSON corpus.
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { APP_ENV, JSON_DIR, CATALOG_DB_FILE } = require('../config');

const LEGACY_VALIDATION_FILE = path.join(__dirname, '..', 'validated_recipes.json');
const DEFAULT_VALIDATION_FILE = path.join(__dirname, 'validated_recipes.json');

function resolveValidationFile(validationArg) {
  if (validationArg) {
    return path.resolve(validationArg.split('=')[1]);
  }
  if (fs.existsSync(DEFAULT_VALIDATION_FILE)) {
    return DEFAULT_VALIDATION_FILE;
  }
  return LEGACY_VALIDATION_FILE;
}

function sanitizeString(value) {
  if (value === null || value === undefined) return null;
  return String(value).trim();
}

function extractServing(recipe) {
  if (typeof recipe.servingSize === 'number' && recipe.servingSize > 0) {
    return recipe.servingSize;
  }
  if (Array.isArray(recipe.yields) && recipe.yields.length > 0) {
    return recipe.yields[0].yields || null;
  }
  return null;
}

function parseRecipeStatus(recipe) {
  // Detect recipe status from JSON metadata
  // recipeStatus is added by download-images.js during processing
  if (!recipe.recipeStatus) {
    return { status: 'UNKNOWN', missingCount: 0, successCount: 0 };
  }
  const missing = recipe.recipeStatus.missing || [];
  const success = recipe.recipeStatus.success || 0;
  let status = 'FAIL';
  if (success > 0 && missing.length === 0) status = 'OK';
  else if (success > 0 && missing.length > 0) status = 'REGULAR';
  return { status, missingCount: missing.length, successCount: success };
}

function run() {
  if (!fs.existsSync(JSON_DIR)) {
    console.error(`JSON directory not found: ${JSON_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(JSON_DIR).filter((f) => f.endsWith('.json'));
  const replaceDB = process.argv.includes('--replace') || process.argv.includes('--force');
  const incremental = !replaceDB;
  const onlyOk = process.argv.includes('--extract-only-ok');
  const skipFailures = process.argv.includes('--skip-failures');
  const validationArg = process.argv.find((a) => a.startsWith('--validation-file='));
  const VALIDATION_FILE = resolveValidationFile(validationArg);

  if (!fs.existsSync(VALIDATION_FILE)) {
    console.error(`Validation file no encontrado: ${VALIDATION_FILE}`);
    console.error('Ejecute: node validate-recipes.js y luego vuelva a ejecutar generate-db.js');
    process.exit(1);
  }

  const validationJson = JSON.parse(fs.readFileSync(VALIDATION_FILE, 'utf8'));
  const validatedList = Array.isArray(validationJson.validated) ? validationJson.validated : [];
  const validatedIds = new Set(validatedList.map((it) => it.id).filter(Boolean));

  if (validatedIds.size === 0) {
    console.error('No hay recetas validadas en el archivo de validación. Ejecuta validate-recipes.js primero.');
    process.exit(1);
  }

  if (replaceDB && fs.existsSync(CATALOG_DB_FILE)) {
    fs.unlinkSync(CATALOG_DB_FILE);
  }

  const db = new sqlite3.Database(CATALOG_DB_FILE);
  let inserted = 0, skipped = 0;
  let existingInDb = 0;

  db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL');

    db.run('CREATE TABLE IF NOT EXISTS recipe (id TEXT PRIMARY KEY, uuid TEXT, name TEXT, slug TEXT, headline TEXT, description TEXT, difficulty INTEGER, prepTime TEXT, totalTime TEXT, servings INTEGER, imageLink TEXT, localImage TEXT, cardLink TEXT, localCard TEXT, country TEXT, averageRating REAL, json TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS ingredient (id TEXT PRIMARY KEY, name TEXT, type TEXT, slug TEXT, country TEXT, imageLink TEXT, localImage TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS recipe_ingredient (recipe_id TEXT, ingredient_id TEXT, amount REAL, unit TEXT, PRIMARY KEY(recipe_id, ingredient_id))');
    db.run('CREATE TABLE IF NOT EXISTS recipe_status (recipe_id TEXT PRIMARY KEY, name TEXT, status TEXT, synced_at TEXT)');
    db.run('CREATE INDEX IF NOT EXISTS idx_recipe_name ON recipe(name)');
    db.run('CREATE INDEX IF NOT EXISTS idx_ingredient_name ON ingredient(name)');
    db.run('CREATE INDEX IF NOT EXISTS idx_recipe_status ON recipe_status(status)');

    db.all('SELECT recipe_id FROM recipe_status', [], (err, rows) => {
      const existingRecipeIds = new Set();
      if (!err && rows) {
        rows.forEach((row) => existingRecipeIds.add(row.recipe_id));
      }
      existingInDb = existingRecipeIds.size;
      console.log(`Recetas ya en DB (antes de procesar): ${existingInDb}`);

      const stmtRecipe = db.prepare('INSERT OR REPLACE INTO recipe VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const stmtIngredient = db.prepare('INSERT OR IGNORE INTO ingredient VALUES (?, ?, ?, ?, ?, ?, ?)');
    const stmtRecipeIngredient = db.prepare('INSERT OR REPLACE INTO recipe_ingredient VALUES (?, ?, ?, ?)');
    const stmtRecipeStatus = db.prepare('INSERT OR REPLACE INTO recipe_status VALUES (?, ?, ?, ?)');

    for (const fileName of files) {
      try {
        const jsonPath = path.join(JSON_DIR, fileName);
        const raw = fs.readFileSync(jsonPath, 'utf8');
        const recipe = JSON.parse(raw);

        const recipeId = recipe.id || recipe.uuid || null;
        if (!recipeId) {
          skipped++;
          continue;
        }

        if (!validatedIds.has(recipeId)) {
          skipped++;
          console.log(`  Skipping no validada (no OK en validacion): ${recipe.name || recipeId}`);
          continue;
        }

        // In incremental mode, skip if already exists in DB
        if (incremental && existingRecipeIds.has(recipeId)) {
          skipped++;
          console.log(`  Skipping ya existe en DB: ${recipe.name || recipeId}`);
          continue;
        }

        // Parse recipe download status
        const recipeStatus = parseRecipeStatus(recipe);

        // Apply filters
        if (onlyOk && recipeStatus.status !== 'OK') {
          skipped++;
          console.log(`  Skipping (status=${recipeStatus.status}): ${recipe.name}`);
          continue;
        }
        if (skipFailures && recipeStatus.status === 'FAIL') {
          skipped++;
          console.log(`  Skipping (FAIL): ${recipe.name}`);
          continue;
        }

        const alreadyExists = existingRecipeIds.has(recipeId);
        // existingInDb ya contiene el número de filas iniciales; no incrementamos aquí.
        if (alreadyExists) {
          // Dejar constancia en log si queremos, sin alterar el contador base.
          // console.log(`  Ya existía con recipe_id: ${recipeId}`);
        }

        const servings = extractServing(recipe);

        stmtRecipe.run(
          recipeId,
          sanitizeString(recipe.uuid),
          sanitizeString(recipe.name),
          sanitizeString(recipe.slug),
          sanitizeString(recipe.headline),
          sanitizeString(recipe.description),
          Number(recipe.difficulty) || null,
          sanitizeString(recipe.prepTime),
          sanitizeString(recipe.totalTime),
          servings,
          sanitizeString(recipe.imageLink),
          sanitizeString(recipe.localImage),
          sanitizeString(recipe.cardLink),
          sanitizeString(recipe.localCard),
          sanitizeString(recipe.country),
          Number(recipe.averageRating) || null,
          JSON.stringify(recipe)
        );

        // Track recipe sync status
        stmtRecipeStatus.run(
          recipeId,
          sanitizeString(recipe.name),
          recipeStatus.status,
          new Date().toISOString()
        );

        if (Array.isArray(recipe.ingredients)) {
          for (const ingredient of recipe.ingredients) {
            const ingredientId = ingredient.id || ingredient.uuid || `${recipeId}-${ingredient.name}`;
            stmtIngredient.run(
              ingredientId,
              sanitizeString(ingredient.name),
              sanitizeString(ingredient.type),
              sanitizeString(ingredient.slug),
              sanitizeString(ingredient.country),
              sanitizeString(ingredient.imageLink),
              sanitizeString(ingredient.localImage)
            );

            let amount = null;
            let unit = null;
            if (ingredient.amount) amount = Number(ingredient.amount);
            if (ingredient.unit) unit = sanitizeString(ingredient.unit);

            stmtRecipeIngredient.run(recipeId, ingredientId, amount, unit);
          }
        }

        inserted++;
      } catch (err) {
        console.error(`Error processing ${fileName}: ${err.message}`);
        skipped++;
      }
    }

    stmtRecipe.finalize();
    stmtIngredient.finalize();
    stmtRecipeIngredient.finalize();
    stmtRecipeStatus.finalize();

    console.log(`\n=== Database generation complete ===`);
    console.log(`Environment: ${APP_ENV}`);
    console.log(`Catalog database: ${CATALOG_DB_FILE}`);
    console.log(`Total JSON files scanned: ${files.length}`);
    console.log(`Validated recipes in file: ${validatedIds.size}`);
    console.log(`Existing recipes in DB (antes de escribir): ${existingInDb}`);
    console.log(`Inserted/Updated recipes: ${inserted}`);
    console.log(`Skipped recipes: ${skipped}`);
    if (incremental) console.log(`Mode: INCREMENTAL (existing data preserved)`);
    if (onlyOk) console.log(`Filter: ONLY_OK (status=OK)`);
    if (skipFailures) console.log(`Filter: SKIP_FAILURES (status!=FAIL)`);

    db.close((err) => {
      if (err) {
        console.error('Error closing DB:', err.message);
      } else {
        console.log('DB closed');
      }
    });
  }); // end db.all callback
}); // end db.serialize

}


run();
