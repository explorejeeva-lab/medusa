# Local Development Setup

Step-by-step guide to set up the Medusa monorepo and a linked test project on your machine.

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | >= 20 | Use [nvm](https://github.com/nvm-sh/nvm) to manage versions |
| Yarn | 3.2.1 | Enabled via Corepack |
| PostgreSQL | >= 14 | Must be running locally |
| Git | any | Required to clone |

### 1. Install Node.js >= 20

```bash
# Using nvm (recommended)
nvm install 20
nvm use 20
node --version  # should print v20.x.x
```

### 2. Enable Corepack and activate Yarn 3

```bash
corepack enable
corepack prepare yarn@3.2.1 --activate
yarn --version  # should print 3.2.1
```

### 3. Install and start PostgreSQL

```bash
# macOS (Homebrew)
brew install postgresql@14
brew services start postgresql@14

# Ubuntu/Debian
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

---

## Part 1 — Clone and build the monorepo

### 4. Clone the repository

The test project and the cloned monorepo must live as **sibling directories**:

```
workspace/
├── medusa/          ← cloned monorepo (this repo)
└── test-project/    ← Medusa application for local testing
```

Clone into a parent folder you control:

```bash
mkdir workspace && cd workspace
git clone https://github.com/medusajs/medusa.git
cd medusa
```

If you are contributing, fork first then add the upstream remote:

```bash
git clone https://github.com/<your-username>/medusa.git
cd medusa
git remote add upstream https://github.com/medusajs/medusa.git
```

### 5. Install dependencies

```bash
yarn install
```

### 6. Build all packages

This compiles every package in dependency order. It takes a few minutes on the first run.

```bash
yarn build
```

---

## Part 2 — Set up the test project

The test project is a minimal Medusa application whose `package.json` uses `file:` paths to resolve every `@medusajs/*` package from the local monorepo rather than from npm.

### 7. Create the test-project directory

From inside `workspace/` (one level above `medusa/`):

```bash
cd ..   # now in workspace/
mkdir test-project && cd test-project
yarn init -y
```

### 8. Add `package.json` content

Replace the generated `package.json` with the following. Every `file:` path points at a package inside the sibling `medusa/` clone.

```json
{
  "name": "test-project",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "build": "medusa build",
    "dev": "medusa develop",
    "start": "medusa start",
    "db:migrate": "medusa db:migrate"
  },
  "dependencies": {
    "@medusajs/admin-bundler":          "file:../medusa/packages/admin/admin-bundler",
    "@medusajs/admin-sdk":              "file:../medusa/packages/admin/admin-sdk",
    "@medusajs/api-key":                "file:../medusa/packages/modules/api-key",
    "@medusajs/auth":                   "file:../medusa/packages/modules/auth",
    "@medusajs/auth-emailpass":         "file:../medusa/packages/modules/providers/auth-emailpass",
    "@medusajs/cache-inmemory":         "file:../medusa/packages/modules/cache-inmemory",
    "@medusajs/cart":                   "file:../medusa/packages/modules/cart",
    "@medusajs/cli":                    "file:../medusa/packages/cli/medusa-cli",
    "@medusajs/core-flows":             "file:../medusa/packages/core/core-flows",
    "@medusajs/currency":               "file:../medusa/packages/modules/currency",
    "@medusajs/customer":               "file:../medusa/packages/modules/customer",
    "@medusajs/event-bus-local":        "file:../medusa/packages/modules/event-bus-local",
    "@medusajs/file":                   "file:../medusa/packages/modules/file",
    "@medusajs/file-local":             "file:../medusa/packages/modules/providers/file-local",
    "@medusajs/framework":              "file:../medusa/packages/core/framework",
    "@medusajs/fulfillment":            "file:../medusa/packages/modules/fulfillment",
    "@medusajs/fulfillment-manual":     "file:../medusa/packages/modules/providers/fulfillment-manual",
    "@medusajs/index":                  "file:../medusa/packages/modules/index",
    "@medusajs/inventory":              "file:../medusa/packages/modules/inventory",
    "@medusajs/link-modules":           "file:../medusa/packages/modules/link-modules",
    "@medusajs/locking":                "file:../medusa/packages/modules/locking",
    "@medusajs/medusa":                 "file:../medusa/packages/medusa",
    "@medusajs/notification":           "file:../medusa/packages/modules/notification",
    "@medusajs/notification-local":     "file:../medusa/packages/modules/providers/notification-local",
    "@medusajs/order":                  "file:../medusa/packages/modules/order",
    "@medusajs/payment":                "file:../medusa/packages/modules/payment",
    "@medusajs/pricing":                "file:../medusa/packages/modules/pricing",
    "@medusajs/product":                "file:../medusa/packages/modules/product",
    "@medusajs/promotion":              "file:../medusa/packages/modules/promotion",
    "@medusajs/region":                 "file:../medusa/packages/modules/region",
    "@medusajs/sales-channel":          "file:../medusa/packages/modules/sales-channel",
    "@medusajs/stock-location":         "file:../medusa/packages/modules/stock-location",
    "@medusajs/store":                  "file:../medusa/packages/modules/store",
    "@medusajs/tax":                    "file:../medusa/packages/modules/tax",
    "@medusajs/types":                  "file:../medusa/packages/core/types",
    "@medusajs/user":                   "file:../medusa/packages/modules/user",
    "@medusajs/utils":                  "file:../medusa/packages/core/utils",
    "@medusajs/workflow-engine-inmemory": "file:../medusa/packages/modules/workflow-engine-inmemory"
  },
  "devDependencies": {
    "@medusajs/test-utils": "file:../medusa/packages/medusa-test-utils",
    "typescript": "^5.0.0"
  },
  "resolutions": {
    "@medusajs/admin-bundler":          "file:../medusa/packages/admin/admin-bundler",
    "@medusajs/admin-sdk":              "file:../medusa/packages/admin/admin-sdk",
    "@medusajs/api-key":                "file:../medusa/packages/modules/api-key",
    "@medusajs/auth":                   "file:../medusa/packages/modules/auth",
    "@medusajs/auth-emailpass":         "file:../medusa/packages/modules/providers/auth-emailpass",
    "@medusajs/cache-inmemory":         "file:../medusa/packages/modules/cache-inmemory",
    "@medusajs/cart":                   "file:../medusa/packages/modules/cart",
    "@medusajs/core-flows":             "file:../medusa/packages/core/core-flows",
    "@medusajs/currency":               "file:../medusa/packages/modules/currency",
    "@medusajs/customer":               "file:../medusa/packages/modules/customer",
    "@medusajs/event-bus-local":        "file:../medusa/packages/modules/event-bus-local",
    "@medusajs/file":                   "file:../medusa/packages/modules/file",
    "@medusajs/file-local":             "file:../medusa/packages/modules/providers/file-local",
    "@medusajs/framework":              "file:../medusa/packages/core/framework",
    "@medusajs/fulfillment":            "file:../medusa/packages/modules/fulfillment",
    "@medusajs/fulfillment-manual":     "file:../medusa/packages/modules/providers/fulfillment-manual",
    "@medusajs/index":                  "file:../medusa/packages/modules/index",
    "@medusajs/inventory":              "file:../medusa/packages/modules/inventory",
    "@medusajs/link-modules":           "file:../medusa/packages/modules/link-modules",
    "@medusajs/locking":                "file:../medusa/packages/modules/locking",
    "@medusajs/medusa":                 "file:../medusa/packages/medusa",
    "@medusajs/notification":           "file:../medusa/packages/modules/notification",
    "@medusajs/notification-local":     "file:../medusa/packages/modules/providers/notification-local",
    "@medusajs/order":                  "file:../medusa/packages/modules/order",
    "@medusajs/payment":                "file:../medusa/packages/modules/payment",
    "@medusajs/pricing":                "file:../medusa/packages/modules/pricing",
    "@medusajs/product":                "file:../medusa/packages/modules/product",
    "@medusajs/promotion":              "file:../medusa/packages/modules/promotion",
    "@medusajs/region":                 "file:../medusa/packages/modules/region",
    "@medusajs/sales-channel":          "file:../medusa/packages/modules/sales-channel",
    "@medusajs/stock-location":         "file:../medusa/packages/modules/stock-location",
    "@medusajs/store":                  "file:../medusa/packages/modules/store",
    "@medusajs/tax":                    "file:../medusa/packages/modules/tax",
    "@medusajs/test-utils":             "file:../medusa/packages/medusa-test-utils",
    "@medusajs/types":                  "file:../medusa/packages/core/types",
    "@medusajs/user":                   "file:../medusa/packages/modules/user",
    "@medusajs/utils":                  "file:../medusa/packages/core/utils",
    "@medusajs/workflow-engine-inmemory": "file:../medusa/packages/modules/workflow-engine-inmemory"
  }
}
```

### 9. Add `medusa-config.js`

Create `test-project/medusa-config.js`:

```js
const { defineConfig, Modules } = require("@medusajs/framework/utils")

module.exports = defineConfig({
  admin: {
    disable: false,
  },
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: process.env.STORE_CORS || "http://localhost:8000",
      adminCors: process.env.ADMIN_CORS || "http://localhost:9000",
      authCors: process.env.AUTH_CORS || "http://localhost:9000",
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    },
  },
  modules: [
    { resolve: "@medusajs/medusa/cache-inmemory" },
    { resolve: "@medusajs/medusa/event-bus-local" },
    { resolve: "@medusajs/medusa/workflow-engine-inmemory" },
  ],
})
```

### 10. Add `.env`

Create `test-project/.env`. Medusa loads this file automatically on startup.

```bash
DATABASE_URL=postgres://postgres:@localhost:5432/medusa_dev
JWT_SECRET=supersecret
COOKIE_SECRET=supersecret
STORE_CORS=http://localhost:8000
ADMIN_CORS=http://localhost:9000
AUTH_CORS=http://localhost:9000
```

> If your PostgreSQL user has a password, use `postgres://<user>:<password>@localhost:5432/medusa_dev`.

### 11. Create the database

```bash
createdb medusa_dev
# or via psql:
psql -U postgres -c "CREATE DATABASE medusa_dev;"
```

### 12. Install dependencies

```bash
# inside test-project/
yarn install
```

### 13. Run database migrations

```bash
yarn db:migrate
```

### 14. Start the development server

```bash
yarn dev
```

- API: `http://localhost:9000`
- Admin dashboard: `http://localhost:9000/app`

---

## Part 3 — Running tests

All test commands are run from the **root of the monorepo** (`workspace/medusa/`).

### Unit tests

```bash
yarn test
```

### Package integration tests

```bash
yarn test:integration:packages
```

### HTTP integration tests

Uses `integration-tests/.env.test` for database credentials. Ensure that file exists:

```
DB_HOST=localhost
DB_USERNAME=postgres
DB_PASSWORD=
LOG_LEVEL=error
```

```bash
yarn test:integration:http
```

### API integration tests

```bash
yarn test:integration:api
```

### Module integration tests

```bash
yarn test:integration:modules
```

---

## Workflow: making and testing changes

1. Edit source files in `workspace/medusa/packages/...`.
2. Rebuild the changed package from the monorepo root:
   ```bash
   yarn workspace @medusajs/<package-name> build
   ```
   Or run watch mode inside the package directory for continuous rebuilds:
   ```bash
   cd packages/core/framework   # example
   yarn watch
   ```
3. Reinstall in the test project to pick up the new build output:
   ```bash
   cd ../../test-project
   rm -rf node_modules && yarn install && yarn dev
   ```

---

## Troubleshooting

**`yarn install` fails with unsupported engine errors**
Verify Node.js is >= 20: `node --version`. Switch with `nvm use 20`.

**PostgreSQL connection refused**
Check the service is running: `pg_isready`. Confirm the `DATABASE_URL` in `.env` matches your local credentials and that the `medusa_dev` database exists.

**`yarn build` fails on first run**
Run `yarn install` from the monorepo root first, then retry `yarn build`. Missing peer dependencies from a partial install are the most common cause.

**Admin dashboard shows a blank page**
Confirm `admin.disable` is `false` in `medusa-config.js` and that the origin you are accessing from is listed in `ADMIN_CORS`.

**Changes not reflected in the test project**
Building the package is not enough — you must also reinstall in the test project (`rm -rf node_modules && yarn install`) so Yarn re-copies the new build output into `node_modules`.

**`yarn db:migrate` cannot find the medusa CLI**
Run `yarn install` first. The `medusa` binary comes from `@medusajs/cli` which must be installed before any script can invoke it.
