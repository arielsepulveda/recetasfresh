# Recetas FRESH

Recetas FRESH is a private-ready recipe web app focused on browsing recipes, saving favorites, building a shopping cart, and exporting shopping lists.

The project started from HelloFresh recipe archives and evolved into a complete multi-user application with authentication, invite-only onboarding, and persistent sessions.

## Current Version

- `0.3.0`

## What Is Implemented

### Core Product Features

- Recipe browser with search and filtering.
- Recipe detail view with ingredients, steps, metadata, and PDF card links.
- Favorites per user.
- Favorites search with the same filters as the main browser (text, country, difficulty, max time, cuisine).
- Shopping cart per user with servings.
- Archived carts per user (save, list, reload to cart, delete).
- Automatic ingredient aggregation across cart recipes.
- Shopping list export as TXT, CSV, and iPhone-friendly text (Reminders/Notes).

### Authentication and User Model

- Register, login, logout.
- Password hashing with `bcryptjs`.
- Session-based auth (cookie `recetas.sid`).
- Multi-user isolation for favorites and cart.
- Role support (`user`, `admin`).

### Admin and Invite System

- Admin emails configurable from `app-settings.json`.
- Public registration toggle (`allowPublicRegistration`).
- Bootstrap admin flow when no configured admin exists.
- Invite creation with:
  - optional target email
  - max uses (`maxUses`)
  - expiration days (`expiresInDays`)
- Invite-only registration support via `?invite=<token>` URL.
- Admin invite list endpoint and UI.
- Invite deletion (admin can remove their own invites).

### Persistent Sessions

- Session store migrated from memory to SQLite using `connect-sqlite3`.
- Sessions now persist across Node process restarts.
- Session DB can be configured per environment.

## Architecture

- Backend: `server.js` (Express + REST API)
- Frontend: `public/index.html` (Vue 3 SPA)
- Configuration: `config.js` + `app-settings.json`
- Catalog DB (shared): `data/recipes.db`
- App DB (mutable user data):
  - production: `data/app.db`
  - development: `data/app.dev.db`
- Session DB:
  - production: `data/sessions.db`
  - development: `data/sessions.dev.db`

## Main Data Separation

### Catalog Database (`data/recipes.db`)

Stores read-oriented recipe data:

- `recipe`
- `ingredient`
- `recipe_ingredient`
- `recipe_status`

### App Database (`data/app.db` / `data/app.dev.db`)

Stores mutable application data:

- `user`
- `user_settings`
- `favorite`
- `cart`
- `archived_cart`
- `archived_cart_item`
- `invite`
- `schema_migration`

### Schema Migrations

- App DB schema changes are now applied through ordered, idempotent migrations before the server starts listening.
- Applied migrations are tracked in the `schema_migration` table.
- This keeps production upgrades additive and safe for existing users, favorites, carts, and invites.
- Future features such as archived carts or ratings should be added as new migrations instead of expanding startup bootstrap code.

### Session Database (`data/sessions.db` / `data/sessions.dev.db`)

Stores active server sessions managed by `express-session` + `connect-sqlite3`.

## Quick Start

### Prerequisites

- Node.js 14+
- npm

### Install

```bash
npm install
```

### Build/Refresh Catalog DB

```bash
npm run generate-db
```

### Run Production Mode Locally

```bash
npm run serve:prod
```

Open:

- `http://localhost:3000`

### Run Development Mode

```bash
npm run serve:dev
```

Open:

- `http://localhost:3001`

## Environment Variables

- `APP_ENV`: `production` or `development`
- `PORT`: server port
- `JSON_DIR`: path to JSON recipe files
- `CATALOG_DB_FILE`: path to shared recipe DB
- `APP_DB_FILE`: path to mutable app DB
- `SESSION_DB_FILE`: path to SQLite session DB
- `SESSION_SECRET`: cookie/session signing secret
- `ALLOW_REGISTRATION`: optional runtime override for public registration (`true`/`false`)

## Scripts

- `npm run serve`: start production mode through `scripts/start-env.js` (launches `server.js`)
- `npm run serve:dev`: start development environment
- `npm run serve:prod`: start production environment
- `npm run generate-db`: build catalog DB
- `npm run generate-db:dev`: regenerate catalog DB in dev workflow
- `npm run generate-db:prod`: regenerate catalog DB in prod workflow
- `npm run validate-recipes`: generate validation metadata from crawler JSON files
- `npm run download-images`: download local recipe images
- `npm run json-server`: fetch/export recipes from HelloFresh source

## Repository File Map

### Runtime App (active)

- `server.js`: main Express API server + auth/session/cart/favorites/invites.
- `public/index.html`: Vue SPA frontend used by the app.
- `config.js`: centralized environment/config resolution.
- `app-migrations.js`: ordered app DB migrations executed at server startup.

### Crawler / Preprocessing Pipeline

Everything related to the original crawl and catalog preparation now lives under `crawler/`.
See `crawler/README.md` for the full pipeline description.

### Crawler and Data Build (active)

- `crawler/index.js`: CLI entry for PDF crawler flow.
- `crawler/services/hello-fresh.js`: crawler service implementation (recipe cards/PDF metadata source).
- `crawler/index_json.js`: CLI entry for JSON export flow.
- `crawler/services/hello-fresh-json.js`: crawler service implementation for JSON exports.
- `crawler/generate-db.js`: builds/refreshes `recipes.db` from `crawler/downloads_json/`.
- `crawler/download-images.js`: downloads and maps local images into recipe JSON assets.
- `crawler/downloads_json/`: source JSON corpus used during preprocessing.
- `crawler/validated_recipes.json`: validation metadata used by the preprocessing pipeline.
- `scripts/start-env.js`: helper launcher for `server.js` with environment defaults.
- `scripts/generate-db-env.js`: helper launcher for `crawler/generate-db.js` with environment defaults.
- `crawler/utils/array.js`: array batching helpers used by crawler scripts.
- `crawler/utils/colours.js`: console color helpers for CLI logs.

### Data QA / Validation Utilities (manual)

- `crawler/validate-recipes.js`: generates `crawler/validated_recipes.json` summary from `crawler/downloads_json/`.
- `crawler/qa/check_local_images.ps1`: random sampling check for `localImage` paths and missing files.

### Legacy One-Off Debug Scripts (not part of runtime)

These files are not imported by app/crawler runtime code and are not included in npm scripts. They were moved to `crawler/debug/` and documented in `crawler/debug/README.md`:

- `crawler/debug/check_lomo.py`
- `crawler/debug/inspect_recipe.py`
- `crawler/debug/check_status.py`
- `crawler/debug/check_validated_status.py`
- `crawler/debug/find_regular_missing.py`
- `crawler/debug/test-image-url-candidates.js`

If they are no longer needed, they are good candidates for removal.

## Configuration File

`app-settings.json` supports:

- `adminEmails`: list of admin emails
- `allowPublicRegistration`: boolean
- `inviteDefaults.maxUses`: default max uses per invite
- `inviteDefaults.expiresInDays`: default invite duration

## Deployment Notes (cPanel)

- Keep production and development as separate Node processes.
- Use different `APP_DB_FILE` and `SESSION_DB_FILE` for each environment.
- Keep the same `CATALOG_DB_FILE` if both should share the same recipe catalog.
- Set a strong `SESSION_SECRET` in production.

## Security Notes

- API access to user data is protected by authenticated session.
- Passwords are stored hashed (never plain text).
- For private deployments, you can still add cPanel directory/password protection in front of the app as an extra layer.

## Data & Privacy

- Recipes come from HelloFresh public archives (respecting their terms).
- User data (favorites/cart/auth-related state) is stored locally in SQLite.
- Shopping list export is generated locally and not sent to external services.
