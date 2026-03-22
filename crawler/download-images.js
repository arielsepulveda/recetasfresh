// Downloads recipe and ingredient images and writes local asset paths back into JSON files.
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const JSON_DIR = path.join(__dirname, "downloads_json");
const LOG_FILE = path.join(__dirname, "download-images.log");
const ROOT_DIR = path.resolve(__dirname, '..');
const LEGACY_VALIDATION_FILE = path.join(ROOT_DIR, 'validated_recipes.json');
const DEFAULT_VALIDATION_FILE = path.join(__dirname, 'validated_recipes.json');
const IMAGES_DIR = path.join(ROOT_DIR, "images");
const RECIPE_IMG_DIR = path.join(IMAGES_DIR, "recipes");
const INGREDIENT_IMG_DIR = path.join(IMAGES_DIR, "ingredients");

function resolveValidationFile(validationArg) {
  if (validationArg) {
    return path.resolve(validationArg.split('=')[1]);
  }
  if (fs.existsSync(DEFAULT_VALIDATION_FILE)) {
    return DEFAULT_VALIDATION_FILE;
  }
  return LEGACY_VALIDATION_FILE;
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHelloFreshPath(rawPath) {
  if (!rawPath) return null;
  const noQuery = rawPath.split("?")[0];
  // Strip leading CDN size prefix (e.g., /200,200/ingredient/..., /0,0/image/...)
  const cleaned = noQuery.replace(/^\/(\d+,\d+\/)*/, "/");
  // Ensure path starts with slash
  return cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
}

function buildImageCandidates(link, imagePath) {
  const candidates = [];

  // Prefer stable media.hellofresh.com + c_limit, no cloudfront probes
  const baseMedia = "https://media.hellofresh.com/w_750,q_auto,f_auto,c_limit,fl_lossy/hellofresh_s3";
  const baseMediaFallback = "https://media.hellofresh.com/w_384,q_auto,f_auto,c_limit,fl_lossy/hellofresh_s3";

  const candidatePaths = [];

  if (imagePath) {
    const normalized = normalizeHelloFreshPath(imagePath);
    if (normalized) candidatePaths.push(normalized);
  }

  if (link) {
    try {
      const url = new URL(link);
      const normalized = normalizeHelloFreshPath(url.pathname);
      if (normalized) candidatePaths.push(normalized);
    } catch (err) {
      // If link is not a URL, fallback to raw path
      const normalized = normalizeHelloFreshPath(link);
      if (normalized) candidatePaths.push(normalized);
    }
  }

  for (const p of [...new Set(candidatePaths)]) {
    candidates.push(`${baseMedia}${p}`);
    candidates.push(`${baseMediaFallback}${p}`);
  }

  // Keep original link as last resort if nothing else works
  if (link) candidates.push(link);

  return [...new Set(candidates)];
}

const initialLogHeader = `Download-images log generated ${new Date().toISOString()}\n`;
fs.writeFileSync(LOG_FILE, initialLogHeader, "utf8");

let isShuttingDown = false;

function logLine(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  fs.appendFileSync(LOG_FILE, line, "utf8");
}

function setupSignalHandlers() {
  process.on("SIGINT", () => {
    if (isShuttingDown) {
      console.log("Second SIGINT received, forcing exit.");
      process.exit(1);
    }
    isShuttingDown = true;
    const msg = "Interrupted by user (SIGINT). Stopping after current recipe.";
    console.log(msg);
    logLine(msg);
  });
}

setupSignalHandlers();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryDownloadImage(url, destPath) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 20000,
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "image/*,*/*;q=0.8",
      "Referer": "https://www.hellofresh.es/",
    },
    validateStatus: (status) => status < 500,
  });

  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status}`);
  }

  fs.writeFileSync(destPath, response.data);
  console.log(`Downloaded: ${url} -> ${destPath}`);
}

async function politeWait() {
  // 120ms between tries by default to avoid burst throttling
  await delay(120);
}

async function downloadImage(url, destPath, imagePath) {
  if (fs.existsSync(destPath)) {
    return { ok: true, reason: "cached", url: destPath };
  }

  const candidates = buildImageCandidates(url, imagePath);

  let lastError;
  const tries = [];
  for (const [index, candidate] of candidates.entries()) {
    try {
      await tryDownloadImage(candidate, destPath);
      logLine(`Image success: ${destPath} from ${candidate}`);
      return { ok: true, url: candidate, tries };
    } catch (err) {
      lastError = err;
      tries.push({ url: candidate, error: err.message });
      const logMsg = `Image fail: ${candidate} -> ${err.message}`;
      console.warn(`- candidate failed: ${candidate} (${err.message})`);
      logLine(logMsg);
    }

    // Espera solamente entre intentos no finales
    if (index < candidates.length - 1) {
      await politeWait();
    }
  }

  const reason = lastError?.message || "unknown";
  console.error(`Error downloading image after ${candidates.length} candidates: ${reason}`);
  return { ok: false, error: reason, tries };
}


function ensureDirs() {
  [IMAGES_DIR, RECIPE_IMG_DIR, INGREDIENT_IMG_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

async function run() {
  ensureDirs();

  const force = process.argv.includes('--force') || process.argv.includes('--replace');
  const retryFailed = process.argv.includes('--retry-failed');
  const validationArg = process.argv.find((a) => a.startsWith('--validation-file='));
  const VALIDATION_FILE = resolveValidationFile(validationArg);

  const validationStatusById = new Map();
  if (fs.existsSync(VALIDATION_FILE)) {
    try {
      const meta = JSON.parse(fs.readFileSync(VALIDATION_FILE, 'utf8'));
      if (Array.isArray(meta.validated)) {
        for (const item of meta.validated) {
          if (item.id && item.status) {
            validationStatusById.set(item.id, item.status.toUpperCase());
          }
        }
      }
      console.log(`Loaded validated list (${validationStatusById.size}) from ${VALIDATION_FILE}`);
    } catch (err) {
      console.warn(`No se pudo leer validation file ${VALIDATION_FILE}: ${err.message}`);
    }
  } else {
    if (!force) {
      console.warn(`Validation file no existe: ${VALIDATION_FILE}. Se reintentará con recipeStatus, si está disponible.`);
    }
  }

  const jsonFiles = fs
    .readdirSync(JSON_DIR)
    .filter((f) => f.toLowerCase().endsWith(".json"));

  function isRecipeComplete(recipe) {
    if (!recipe.localImage) return false;

    if (Array.isArray(recipe.ingredients)) {
      for (const ing of recipe.ingredients) {
        if ((ing.imageLink || ing.imagePath || ing.localImage) && !ing.localImage) return false;
      }
    }

    if (Array.isArray(recipe.steps)) {
      for (const st of recipe.steps) {
        if (st.localImage) continue;
        const images = Array.isArray(st.images) ? st.images : [];
        for (const im of images) {
          if ((im.link || im.path || im.localImage) && !im.localImage) return false;
        }
      }
    }

    return true;
  }

  for (const fileName of jsonFiles) {
    if (isShuttingDown) {
      logLine(`Stop requested. Breaking before processing ${fileName}.`);
      break;
    }

    try {
      const filePath = path.join(JSON_DIR, fileName);
      const raw = fs.readFileSync(filePath, "utf8");
      const recipe = JSON.parse(raw);

      if (!recipe.id || !recipe.name) {
        console.warn(`Skipping invalid JSON: ${fileName}`);
        continue;
      }

      const recipeId = recipe.id || recipe.uuid;
      const existingStatus = (recipe.recipeStatus && recipe.recipeStatus.status) ? recipe.recipeStatus.status.toUpperCase() : null;
      const validatedStatus = validationStatusById.get(recipeId) || existingStatus || 'UNKNOWN';
      const complete = isRecipeComplete(recipe);

      if (!force) {
        if (complete) {
          console.log(`Skipping fully complete recipe: ${recipe.name} (${recipeId})`);
          continue;
        }
        if (validatedStatus === 'OK' && !retryFailed && !complete) {
          console.log(`Recipe previously OK but incomplete, retrying: ${recipe.name} (${recipeId})`);
        }
        if (validatedStatus === 'UNKNOWN' && existingStatus === 'OK' && complete) {
          console.log(`Skipping previously completed recipe (existingStatus OK): ${recipe.name} (${recipeId})`);
          continue;
        }
      }

      const recipeStatus = {
        recipe: recipe.name,
        url: recipe.imageLink || recipe.imagePath || "",
        success: 0,
        missing: [],
      };

      // recipe image
      if (recipe.imageLink || recipe.imagePath) {
        const ext = path.extname(recipe.imagePath || recipe.imageLink).split("?")[0] || ".jpg";
        const safeName = sanitizeFilename(`${recipe.id}-${recipe.name}`).slice(0, 120);
        const localRecipeImage = `/images/recipes/${safeName}${ext}`;
        const absoluteRecipeImage = path.join(RECIPE_IMG_DIR, `${safeName}${ext}`);

        const res = await downloadImage(recipe.imageLink, absoluteRecipeImage, recipe.imagePath);
        if (res.ok) {
          recipe.localImage = localRecipeImage;
          recipeStatus.success++;
        } else {
          recipeStatus.missing.push({ type: "recipe", src: recipe.imageLink || recipe.imagePath, candidates: res.tries || [], error: res.error });
        }
      }

      // ingredient images
      if (Array.isArray(recipe.ingredients)) {
        for (const ingredient of recipe.ingredients) {
          if (ingredient.imageLink || ingredient.imagePath) {
            const ingExt = path.extname(ingredient.imagePath || ingredient.imageLink).split("?")[0] || ".png";
            const ingredientSafeName = sanitizeFilename(`${ingredient.id}-${ingredient.name}`).slice(0, 120);
            const ingDest = path.join(INGREDIENT_IMG_DIR, `${ingredientSafeName}${ingExt}`);

            const res = await downloadImage(ingredient.imageLink, ingDest, ingredient.imagePath);
            if (res.ok) {
              ingredient.localImage = `/images/ingredients/${ingredientSafeName}${ingExt}`;
              recipeStatus.success++;
            } else {
              recipeStatus.missing.push({ type: "ingredient", id: ingredient.id, name: ingredient.name, src: ingredient.imageLink || ingredient.imagePath, candidates: res.tries || [], error: res.error });
            }
          } else if (!ingredient.localImage) {
            recipeStatus.missing.push({ type: "ingredient", id: ingredient.id, name: ingredient.name, src: null, error: "no source imageLink/imagePath" });
          }
        }
      }

      // recipe card link (opcional)
      if (recipe.cardLink) {
        const ext = path.extname(new URL(recipe.cardLink).pathname) || ".pdf";
        const cardPath = path.join(__dirname, "downloads", `${sanitizeFilename(recipe.id + "-" + recipe.name).slice(0, 120)}${ext}`);
        recipe.localCard = `/pdf/${path.basename(cardPath)}`;
      }

      // step images
      if (Array.isArray(recipe.steps)) {
        for (let i = 0; i < recipe.steps.length; i++) {
          const step = recipe.steps[i];
          if (Array.isArray(step.images)) {
            for (let j = 0; j < step.images.length; j++) {
              const stepImage = step.images[j];
              const src = stepImage.link || stepImage.path;
              if (!src) continue;

              const ext = path.extname(stepImage.path || stepImage.link).split("?")[0] || ".jpg";
              const safeName = sanitizeFilename(`${recipe.id}-step-${i + 1}-${j + 1}`).slice(0, 120);
              const localStepImagePath = path.join(RECIPE_IMG_DIR, `${safeName}${ext}`);

              const res = await downloadImage(src, localStepImagePath, stepImage.path);
              if (res.ok) {
                stepImage.localImage = `/images/recipes/${safeName}${ext}`;
                recipeStatus.success++;
              } else {
                recipeStatus.missing.push({ type: "step", step: `${i + 1}.${j + 1}`, src: src, candidates: res.tries || [], error: res.error });
              }
            }
          }
        }
      }

      let lineStatus = "FAIL";
      if (recipeStatus.success > 0 && recipeStatus.missing.length === 0) lineStatus = "OK";
      else if (recipeStatus.success > 0 && recipeStatus.missing.length > 0) lineStatus = "REGULAR";

      recipeStatus.status = lineStatus;
      recipeStatus.synced_at = new Date().toISOString();
      recipe.recipeStatus = recipeStatus;

      logLine(`Recipe: ${recipe.name} | ${lineStatus} | success images: ${recipeStatus.success} | missing images: ${recipeStatus.missing.length}`);

      if (recipeStatus.missing.length > 0) {
        recipeStatus.missing.forEach((m) => {
          const details = `  ${m.type} ${m.name ? m.name : m.step ? m.step : m.id || ""}: src=${m.src || "(none)"} error=${m.error}`;
          logLine(details);
          if (Array.isArray(m.candidates)) {
            m.candidates.forEach((candidate) => {
              logLine(`    candidate: ${candidate.url} -> ${candidate.error}`);
            });
          }
        });
      }

      fs.writeFileSync(filePath, JSON.stringify(recipe, null, 2), "utf8");
    } catch (err) {
      console.error(`Error procesando ${fileName}: ${err.message}`);
      logLine(`Recipe: ${fileName} | FAIL | error parsing or writing: ${err.message}`);
    }
  }

  console.log("Done: images downloaded and JSON updated with local paths.");
}

run().catch((err) => {
  console.error("Fatal error:", err.message);
});
