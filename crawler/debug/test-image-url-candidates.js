// Debug utility that probes alternate HelloFresh image URLs for a sample recipe.
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const JSON_DIR = path.join(__dirname, '..', 'downloads_json');
const SAMPLE_JSON = path.join(JSON_DIR, 'Albóndigas al estilo griego.json');

function buildCandidates(link, imagePath) {
  const candidates = [];
  if (link) candidates.push(link);

  if (link) {
    // convert Cloudfront to media.hellofresh.com if present
    if (link.includes('d3hvwccx09j84u.cloudfront.net')) {
      const parts = link.split('.net');
      if (parts[1]) {
        const segment = parts[1];
        candidates.push(`https://media.hellofresh.com/w_750,q_auto,f_auto,c_fill,fl_lossy/hellofresh_s3${segment}`);
        candidates.push(`https://media.hellofresh.com/w_384,q_auto,f_auto,c_fill,fl_lossy/hellofresh_s3${segment}`);
      }
    }

    // if link has /w_XX/ prefix, also try path-only version
    const match = link.match(/https:\/\/media\.hellofresh\.com\/[^/]+\/hellofresh_s3(\/.*)$/);
    if (match) {
      const p = match[1];
      candidates.push(`https://media.hellofresh.com/w_750,q_auto,f_auto,c_limit,fl_lossy/hellofresh_s3${p}`);
      candidates.push(`https://media.hellofresh.com/w_384,q_auto,f_auto,c_limit,fl_lossy/hellofresh_s3${p}`);
    }
  }

  if (imagePath) {
    const base = 'https://media.hellofresh.com/w_750,q_auto,f_auto,c_limit,fl_lossy/hellofresh_s3';
    candidates.push(`${base}${imagePath}`);
    candidates.push(`${base}/0,0${imagePath}`);
    candidates.push(`${base}/200,200${imagePath}`);
  }

  // obvious radius attempts from cloudfront link forms
  if (link && link.includes('d3hvwccx09j84u.cloudfront.net')) {
    const normalized = link.replace(/\/\d+,\d+\//, '/');
    candidates.push(normalized);
  }

  return [...new Set(candidates)].filter(Boolean);
}

async function testUrl(url) {
  try {
    const r = await axios.head(url, { timeout: 15000, validateStatus: null });
    return { url, status: r.status, contentType: r.headers['content-type'] || null };
  } catch (err) {
    return { url, status: 'ERR', error: err.message };
  }
}

async function run() {
  if (!fs.existsSync(SAMPLE_JSON)) {
    console.error('Sample JSON not found at', SAMPLE_JSON);
    process.exit(1);
  }

  const recipe = JSON.parse(fs.readFileSync(SAMPLE_JSON, 'utf8'));

  const tests = [];

  if (recipe.imageLink || recipe.imagePath) {
    tests.push({ type: 'recipe', id: recipe.id, link: recipe.imageLink, path: recipe.imagePath });
  }

  if (Array.isArray(recipe.ingredients)) {
    for (const ingredient of recipe.ingredients) {
      tests.push({ type: 'ingredient', id: ingredient.id, name: ingredient.name, link: ingredient.imageLink, path: ingredient.imagePath });
    }
  }

  const steps = recipe.steps || [];
  steps.forEach((step, idx) => {
    if (Array.isArray(step.images)) {
      step.images.forEach((img, j) => {
        tests.push({ type: 'step', id: `[${idx + 1}-${j + 1}]`, link: img.link, path: img.path });
      });
    }
  });

  for (const item of tests) {
    const candidates = buildCandidates(item.link, item.path);
    console.log(`\n--- ${item.type} ${item.id} ${item.name ? '- ' + item.name : ''}`);
    console.log('source link:', item.link);
    console.log('source path:', item.path);
    console.log('candidates:', candidates.join(', '));

    for (const candidate of candidates) {
      const res = await testUrl(candidate);
      if (res.status === 200) {
        console.log('OK', res.url, res.status, res.contentType);
        break;
      }
      console.log('FAIL', res.url, res.status, res.error || '');
    }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
