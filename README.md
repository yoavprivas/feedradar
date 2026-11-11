# FeedRadar

Stage C Pub/Sub is deployed and cloud-verified; configuration and evidence are in
[STAGE-C.md](STAGE-C.md). The Redis cache is locally verified and awaits its cloud release;
see [REDIS.md](REDIS.md). Stage C remains open. The default local scan mode is unchanged.

Cloud deployment, updates, backup recovery and cost controls are documented in [DEPLOYMENT.md](DEPLOYMENT.md).

FeedRadar brings articles from websites you choose into a focused, chronological feed. Its Hebrew, right-to-left interface shows the headline, source, and publication time, with a link to the original article, without images or summaries.

## Features

- Add a website URL and discover supported RSS, Atom, JSON Feed, news sitemaps, WordPress REST feeds, or structured HTML.
- Follow and remove sources; collect articles manually or on a configurable schedule.
- Deduplicate articles by source and URL, isolate collection failures, and preserve articles in PostgreSQL.
- Sort by publication time; missing or ambiguous timestamps remain unknown and sort last.
- Responsive Hebrew UI, optional administrator password authentication, and external scheduler support.
- Respect robots.txt and enforce request limits and protections against requests to private networks.

Support depends on the website. FeedRadar does not bypass logins, paywalls, CAPTCHAs, or access restrictions, and does not execute a site's JavaScript. It stores article metadata, not full article bodies. Removing a source also removes its saved articles.

## Stack and architecture

React and TypeScript provide the UI, built with Vite. A Node.js/TypeScript Express server exposes the API and serves the built UI from the same origin. The collector discovers and parses sources; the scanner coordinates collection and isolates failures. PostgreSQL stores sources, articles, migrations, and operational state. SQL queries use parameters; migrations run at server startup or through a dedicated command.

One root package manifest and lockfile manage frontend and backend dependencies. This keeps the existing single-service deployment model while separating the source code:

```text
feedradar/
├── frontend/
│   ├── src/                # React components, styles, and UI copy
│   ├── public/             # Static assets
│   └── index.html
├── backend/                # Express API, collection, scheduling, and PostgreSQL
├── tests/
│   ├── integration/        # Real PostgreSQL + HTTP tests
│   └── browser/            # Playwright end-to-end tests
├── scripts/                # Local database, password, and smoke-test helpers
├── .github/workflows/      # CI and gated manual deployment
├── Dockerfile
├── compose.yaml
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.json
├── vite.config.ts
├── .env.example
└── .gitignore
```

Build output goes to `dist/`. Local secrets, database files, reports, dependencies, and internal project materials are excluded from Git and the Docker build context.

## Local setup

Use Node.js 24, pnpm 11.25.0, and PostgreSQL 17. Run all commands from the repository root.

```sh
git clone https://github.com/yoavprivas/feedradar.git
cd feedradar
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
```

As a PostgreSQL administrator, create an application role and separate application and test databases. Replace the example password before executing:

```sql
CREATE ROLE feedradar LOGIN PASSWORD 'replace-with-a-long-local-password';
CREATE DATABASE feedradar OWNER feedradar;
CREATE DATABASE feedradar_test OWNER feedradar;
```

Copy `.env.example` to `.env` (`cp .env.example .env` in a Unix shell, or `Copy-Item .env.example .env` in PowerShell). Set both database URLs to your credentials and port. A standard PostgreSQL installation uses port 5432; the optional Windows helper uses 55432. Percent-encode special characters in URL passwords.

```sh
pnpm db:migrate
pnpm build
pnpm start
```

Open http://127.0.0.1:4310. Stop the foreground server with Ctrl+C. For development, run `pnpm dev` and `pnpm dev:ui` in separate terminals. Vite serves the frontend and proxies `/api` to port 4310; update the proxy in `vite.config.ts` if you change the backend port.

### Optional Windows helpers

PowerShell 7 is required. To provision a standalone PostgreSQL cluster, run the following **before creating `.env`**, using your own PostgreSQL binary directory:

```powershell
./scripts/local-db.ps1 start -PgBin 'C:/path/to/pgsql/bin'
```

The helper creates `.local/postgres`, random credentials, both databases, and `.env`. For subsequent database starts/stops, supply the same `-PgBin`. Its default binary location is the ignored `.tools/postgresql/pgsql/bin` directory.

`Start-FeedRadar.cmd` and `Stop-FeedRadar.cmd` wrap the PowerShell application launchers. The start helper builds the frontend if needed, starts the bundled local database if present, and opens the browser. Run `pnpm build` after source changes. For an external PostgreSQL installation, use `pnpm start` after starting that database yourself.

## Docker

Docker Engine/Desktop with the Compose plugin is sufficient; Node.js and PostgreSQL need not be installed on the host for normal container use.

Create an ignored `.env.docker` containing `DOCKER_DB_PASSWORD=<a-long-random-hex-value>`. On PowerShell 7, generate it automatically:

```powershell
./scripts/init-docker.ps1
```

On a Unix shell with OpenSSL:

```sh
printf 'DOCKER_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)" > .env.docker
```

Then build and run from the repository root:

```sh
docker compose --env-file .env.docker up --build -d --wait
docker compose --env-file .env.docker ps
```

Open http://127.0.0.1:4311. Compose runs the app as a non-root user with a read-only filesystem, connects it to a separate PostgreSQL container, and stores data in a named volume. The database is not published to the host. `/healthz` checks process health; `/api/health` checks database connectivity. This Compose configuration uses local authentication and binds only to loopback.

```sh
docker compose --env-file .env.docker logs app
docker compose --env-file .env.docker down
```

`down` preserves database data. Do not use `down -v` unless you intend to delete the database. Keep `.env.docker` and its password for reuse with the volume. Rebuild with `up --build -d --wait` after source changes.

## Tests

Configure `TEST_DATABASE_URL` in `.env` to a dedicated test database owned by the test role. Integration and browser tests create and remove randomly named schemas; never point them at a production database.

```sh
pnpm test
pnpm test:integration
pnpm build
pnpm exec playwright install chromium
pnpm test:browser
```

On Linux, use `pnpm exec playwright install --with-deps chromium` if browser system dependencies are missing. To use an already installed compatible Chrome instead, set `BROWSER_CHANNEL=chrome` in your shell.

Unit tests cover discovery, parsing, dates, network restrictions, and security. Integration tests exercise the API, collection, database persistence, migrations, and authentication. Browser tests cover login, source management, refresh, logout, and responsive layouts. Screenshots are written to ignored `test-results/`.

With the Compose stack running and host Node.js available:

```sh
node scripts/docker-smoke.mjs
```

This checks UI/API access, non-root execution, and PostgreSQL persistence after recreating both containers. It creates and removes only its own fixture. Optional public-network checks are `node --import tsx scripts/smoke-live.ts` and `node scripts/docker-live-smoke.mjs`; the latter also requires installed dependencies and Playwright and must use a source not already followed. External site availability can affect these checks.

## Environment variables

See `.env.example` for safe placeholders. The backend reads `.env` from the repository root; no secrets belong in frontend code or `VITE_*` variables.

| Variable | Purpose / default |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection URL |
| `TEST_DATABASE_URL` | Separate database for integration/browser tests |
| `HOST` | Bind address; `127.0.0.1` locally, `0.0.0.0` in Docker |
| `PORT` | HTTP port; 4310 locally, 8080 in Docker |
| `SCAN_INTERVAL_MINUTES` | Local scan interval; 30, range 5–1440 |
| `REQUEST_TIMEOUT_MS` | Collection request timeout; 12000, range 1000–30000 |
| `MIN_REFRESH_SECONDS` | Manual refresh cooldown; 60, range 10–3600 |
| `AUTH_MODE` | `local` or `password`; default `local` |
| `SCHEDULER_MODE` | `local` or `external`; default `local` |
| `PUBLIC_ORIGIN` | Exact public origin; required with password authentication |
| `ADMIN_PASSWORD_HASH` | Secret password hash for password authentication |
| `SCHEDULER_AUDIENCE` | Expected scheduler identity-token audience |
| `SCHEDULER_SERVICE_ACCOUNT` | Expected scheduler service-account email |
| `SCHEDULER_JOB_NAME` | Expected full scheduler job resource name |
| `DATABASE_CA_FILE` | Optional PostgreSQL CA certificate file; TLS verification stays enabled |
| `DOCKER_DB_PASSWORD` | Compose-only password in `.env.docker` |

Generate an administrator hash by supplying the password on standard input to `node --import tsx scripts/password-hash.ts` and ending input with EOF. Avoid putting the password in command arguments or shell history. Keep the result in a secret store. Local scheduling operates only while the backend is running.

## CI and cloud handoff

`.github/workflows/ci.yml` installs locked dependencies, runs unit/integration/browser tests, builds the UI, and builds and smoke-tests Docker with an isolated PostgreSQL service. All paths are relative to the repository root.

The existing deployment workflow remains manual and gated by `CLOUD_DEPLOY_ENABLED`, an approved current-main SHA, successful CI for that SHA, and the `production` environment. It builds the root Dockerfile. No cloud resources are provisioned by local setup.

For the next deployment stage, configure Supabase PostgreSQL connectivity with verified TLS, GCP Artifact Registry/Cloud Run, Workload Identity Federation, Secret Manager, and the scheduler identity. Configure the repository/environment variables referenced by `deploy.yml` before enabling it. Cloud mode requires password authentication, an HTTPS public origin, and external scheduling. Cloud deployment and provider connectivity must be validated separately; a successful local Docker run does not certify them.
