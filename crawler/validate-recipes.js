// Generates validation metadata for crawled recipes before catalog DB generation.
const fs = require('fs');
const path = require('path');

const JSON_DIR = path.join(__dirname, 'downloads_json');
const VALIDATED_FILE = path.join(__dirname, 'validated_recipes.json');

function sanitizeId(recipe) {
  return recipe.id || recipe.uuid || null;
}

function recipeStatus(recipe) {
  const existingStatus = recipe.recipeStatus && typeof recipe.recipeStatus === 'object' && recipe.recipeStatus.status
    ? recipe.recipeStatus.status.toUpperCase()
    : null;

  if (recipe.localImage && Array.isArray(recipe.ingredients) && Array.isArray(recipe.steps)) {
    const missing = [];
    if (!recipe.localImage) missing.push('recipe');
    recipe.ingredients.forEach((ing) => {
      if (!ing.localImage) missing.push(`ingredient:${ing.id || ing.name}`);
    });
    recipe.steps.forEach((st) => {
      if (!st.localImage && (!Array.isArray(st.images) || st.images.some((im) => !im.localImage))) {
        missing.push('step');
      }
    });
    return missing.length === 0 ? 'OK' : 'REGULAR';
  }

  if (existingStatus === 'OK' || existingStatus === 'REGULAR' || existingStatus === 'FAIL') {
    return existingStatus;
  }

  return 'UNKNOWN';
}

function run() {
  const files = fs.readdirSync(JSON_DIR).filter((f) => f.toLowerCase().endsWith('.json'));
  const validated = [];
  let missingStatus = 0;
  let okCount = 0;
  let regularCount = 0;
  let failCount = 0;

  for (const fileName of files) {
    try {
      const raw = fs.readFileSync(path.join(JSON_DIR, fileName), 'utf8');
      const recipe = JSON.parse(raw);
      const status = recipeStatus(recipe);
      if (status === 'OK') {
        okCount++;
      } else if (status === 'REGULAR') {
        regularCount++;
      } else if (status === 'FAIL') {
        failCount++;
      } else {
        missingStatus++;
      }

      if (status === 'OK' || status === 'REGULAR' || status === 'FAIL') {
        validated.push({
          id: sanitizeId(recipe) || `file:${fileName}`,
          name: recipe.name || fileName,
          file: fileName,
          status,
          localImage: recipe.localImage || null,
          ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients.length : 0,
          steps: Array.isArray(recipe.steps) ? recipe.steps.length : 0,
        });
      }
    } catch (err) {
      console.error(`Error parsing ${fileName}: ${err.message}`);
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    total_files: files.length,
    ok_count: okCount,
    regular_count: regularCount,
    fail_count: failCount,
    unknown_count: missingStatus,
    validated_count: validated.length,
    validated: validated,
  };

  fs.writeFileSync(VALIDATED_FILE, JSON.stringify(report, null, 2), 'utf8');

  console.log(`Validation file written: ${VALIDATED_FILE}`);
  console.log(`Total files: ${files.length}, OK: ${okCount}, REGULAR: ${regularCount}, FAIL: ${failCount}, UNKNOWN: ${missingStatus}`);
  console.log(`Validated (OK) records: ${validated.length}`);
}

run();