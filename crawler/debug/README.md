# Debug Scripts (legacy investigation)

This folder groups one-off scripts used during early investigation of image extraction and status validation.

They are not part of runtime app logic, not imported by the crawler, and not executed by npm scripts.

Location: `crawler/debug/`

## Scripts

- `check_lomo.py`
  - Opens `crawler/downloads_json/Lomo marinado en salsa de chalota.json`.
  - Prints recipe-level status and missing `localImage` values for ingredients and step images.

- `inspect_recipe.py`
  - Inspects the same Lomo sample recipe.
  - Prints detailed data for ingredients/step images missing `localImage`.

- `check_status.py`
  - Scans all JSON files in `crawler/downloads_json/`.
  - Finds `recipeStatus.status == REGULAR` entries and prints missing-image positions.

- `check_validated_status.py`
  - Reads `crawler/validated_recipes.json`.
  - Prints the entry for the Lomo sample file and global counters.

- `find_regular_missing.py`
  - Cross-checks `crawler/validated_recipes.json` against real recipe JSON files.
  - Reports recipes with missing `localImage` values (recipe, ingredients, steps).

- `test-image-url-candidates.js`
  - Opens a sample recipe JSON and builds alternative candidate URLs for recipe, ingredient, and step images.
  - Sends HEAD requests to find which HelloFresh image URL variant still responds correctly.

## Notes

- Keep these scripts only for manual forensic/debug usage.
- If they are no longer needed, they can be safely removed.
- If you want to reuse them regularly, consider converting them to JavaScript and adding npm scripts.
