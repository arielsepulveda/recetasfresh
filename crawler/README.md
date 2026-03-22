# Crawler Pipeline

This folder groups the original HelloFresh ingestion pipeline and its working assets.

It is not required for normal site runtime once the catalog DB and local images already exist, but it is still the source pipeline used to refresh recipe data.

## Contents

- `index.js`: CLI for PDF/card crawling.
- `index_json.js`: CLI for JSON export crawling.
- `services/`: crawler service implementations.
- `utils/`: crawler-only utility helpers.
- `downloads_json/`: raw/enriched recipe JSON files used to build the catalog DB.
- `validate-recipes.js`: generates `validated_recipes.json` from the JSON corpus.
- `validated_recipes.json`: validation summary used by image/download and DB generation steps.
- `download-images.js`: downloads local recipe and ingredient images and writes `localImage` metadata into JSON files.
- `generate-db.js`: builds or refreshes the catalog DB from validated JSON files.
- `qa/check_local_images.ps1`: random spot-check utility for local image integrity.
- `debug/`: one-off investigation scripts related to crawler data/image quality.
- `download-images.log` and `download-images.log.old`: crawl/image-download logs.

## Typical Pipeline

1. Export or refresh recipe JSON files.
2. Download and normalize local images.
3. Validate recipe/image completeness.
4. Generate the catalog DB.

## Runtime Boundary

The production site uses:

- `server.js`
- `public/`
- `images/`
- `pdf/`
- `data/*.db`

The site does not require direct access to this folder for day-to-day browsing, except that `server.js` can still expose the JSON corpus through the configured `JSON_DIR` path.
