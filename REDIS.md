# Redis cache — implementation and release instructions

Status, 2026-11-11: Redis is deployed and cloud-verified; Stage C is COMPLETE. Pub/Sub was
verified first. Production source: `29d843b7c62921ba69405c59ea4db4b2041349e3`; web revision
`feedradar-00007-x67`, private worker `feedradar-worker-00003-6dm`. The owner supplied their
existing Upstash Free database `feedradar-cache` on GCP us-central1 through two Secret Manager
secrets. Values were never printed, committed or passed through GitHub variables.

## Behavior

The authenticated latest-articles endpoint uses Redis cache-aside. A valid hit bypasses the
two article/count queries. A miss reads PostgreSQL, returns its result and stores it for
60 seconds. Page size and offset are part of the key; offsets above 500 bypass caching to
limit cache footprint while preserving pagination. Values are limited to 512 KiB.

Migration 4 adds a singleton PostgreSQL `feed_cache_state.revision` and an index for recent
scan batches. Source registration, successful article saves (including publication-date
repairs), and source deletion increment the revision IN THE SAME transaction as the data.
An asynchronous worker does not need Redis credentials to invalidate the feed.

The authenticated session query also reads the revision, so a cache hit performs only the
existing session query and no extra feed queries. Authentication and revocation still
require PostgreSQL. Local mode without session authentication reads the revision separately.

Cache keys include an explicit environment namespace, a fingerprint of the database/role/
connection options with the password removed, the fixed current administrator dataset,
revision, limit and offset. The current application is single-admin; this does not introduce
multi-user accounts or tenant filtering. Neither client parameters nor cookies choose an
owner namespace. Anonymous/expired/revoked sessions cannot reach the cache.

A committed mutation changes the key generation; the next request fills the new generation.
Old generations expire naturally within the TTL. A late old-generation fill cannot overwrite
the new generation. This also prevents stale data returning after Redis recovers from an
outage during a database write. On restoration of an older backup into the same database,
rotate CACHE_NAMESPACE or clear that application's cache prefix before enabling cache.

Redis HTTP requests have a 500 ms timeout and no automatic retries. A cache error falls
back to PostgreSQL; a five-second per-instance circuit breaker avoids repeated delays.
Read errors, write errors, expired/invalid values, provider errors and invalid credentials
do not make otherwise successful feed requests fail. Invalid/incomplete startup settings
fail configuration validation; leaving both credentials unset disables cache completely.
Concurrent misses for one key share a single database fill within an instance.

Only HTTPS Upstash origins are accepted, redirects are disabled, and the token is sent
only in the Authorization header. URLs/tokens/credentials/provider error bodies are not logged.
The UI and API response shape remain unchanged; API responses retain Cache-Control: no-store.

Logs: `cache_hit`, `cache_miss`, `cache_error`, `cache_bypass`, `cache_coalesced`, and
`feed_database_read`. They include page/revision metadata, not article content or credentials.

## Environment

- `UPSTASH_REDIS_REST_URL`: exact HTTPS REST origin, stored as a server-side secret.
- `UPSTASH_REDIS_REST_TOKEN`: full read/write token, stored as a server-side secret.
- `CACHE_NAMESPACE`: distinct namespace, e.g. `feedradar:production`.
- `CACHE_TTL_SECONDS`: default 60, allowed 10–300.
- `CACHE_TIMEOUT_MS`: default 500, allowed 50–2000.

No new npm dependency is needed; Node's fetch uses the documented Upstash REST commands.
Never place real connection values in .env.example, Git, GitHub variables, this document,
frontend code, screenshots or chat. Existing .env exclusions remain in place.

## Secure setup and approved release

Push and Redis deployment require the owner's explicit approval after local review. Do not
change the Upstash plan or enable paid features. Target no fixed monthly charge; shared free
quotas and usage-based cloud services still need monitoring.

1. In the existing GCP project's Secret Manager, create these two secrets and paste values
   directly from the password manager into the console's secret-value field:
   - `feedradar-redis-rest-url`: Upstash REST URL.
   - `feedradar-redis-rest-token`: Upstash full read/write token, NOT its read-only token.
2. Grant `feedradar-runtime@project-43592e87-a1ec-43b7-bb4.iam.gserviceaccount.com`
   secret accessor on ONLY those two named secrets. Do not grant access to the worker.
3. Keep WORKER_ENABLED and PUBSUB_ENABLED true. Set nonsecret repository variables
   REDIS_ENABLED=true and CACHE_NAMESPACE=feedradar:production only for the approved release.
   Workflow references the two secrets by name; no secret value passes through GitHub.
4. Push the reviewed revision, require successful push CI on that exact SHA, pause Scheduler
   briefly and drain BOTH synchronous leases and pending asynchronous tasks. Deploy via the
   existing exact-SHA approved workflow: worker first, then web. Migration 4 is additive.
   Draining is required because an older worker does not yet advance the cache generation.
5. Confirm healthy service, authentication and manual collection; restore the existing
   hourly Scheduler. Inspect actual cache logs and returned data. Roll back Redis enablement
   if cache verification fails, preserving Pub/Sub and the additive migration.
6. To test cloud fallback without disrupting production cache, use a temporary private,
   scale-to-zero validation web service from the same image with a deliberately invalid
   Redis token, approved as part of controlled verification. Delete only that temporary
   service afterward. Production Upstash settings and production secrets stay unchanged.

Direct console: https://console.cloud.google.com/security/secret-manager?project=project-43592e87-a1ec-43b7-bb4

## Verification

Unit tests cover hits/misses, expiry, scopes/pagination, stale in-flight fills, offline writes,
recovery, malformed values, coalescing, provider failures and bounded REST timeouts. Integration
tests use actual isolated PostgreSQL schemas and HTTP authentication with a simulated Redis.
An authenticated miss executes three queries (session + two feed queries); a hit executes one
(session only). Source saves/removal/date repairs refresh results; invalidation failure rolls
back article writes; Redis failure preserves HTTP 200 and current PostgreSQL data.

The browser test exercises queued scanning and cached-feed refresh with simulated Redis and
message transport, including login/logout and mobile widths. Docker verifies the actual image,
migration 4, worker startup and existing persistence behavior. Exact-source CI passed:
https://github.com/yoavprivas/feedradar/actions/runs/42996449212 . Deployment passed:
https://github.com/yoavprivas/feedradar/actions/runs/42996960296 . CI ran 43 unit tests,
53 integration tests, both browser modes and Docker build/persistence checks successfully.

Actual cloud checks also passed:

- Cloud Run populated Upstash; the following authenticated request was a cache hit. The real
  key TTL was 59 seconds, then expired and was refilled with a 60-second TTL.
- Production manual Pub/Sub batch 6c494c16-eb92-4487-98d0-c520f4f7e327 completed both sources,
  added four articles and advanced generation 0 -> 2. New articles were visible through the
  refreshed API/cache. All 234 pre-release articles and both sources were preserved (238 after).
- Actual Scheduler batch 3f5c4f37-b9cd-4c44-b357-6dea12016a0c, key
  scheduled:2026-11-11T09:47:00.000Z, completed both tasks and advanced generation 2 -> 4.
  The updated feed was cached and read successfully. Original hourly cron 28 * * * * UTC is
  enabled; a bounded minute-cron test window was restored immediately after batch creation.
- Dedicated-page production logs recorded four cache_miss/four feed_database_read events
  and three cache_hit events. Hits bypassed feed reads; authentication remained mandatory.
- A temporary private web service from the same image, configured with a deliberately invalid
  Redis token, returned HTTP 200/current PostgreSQL feed for three requests. Logs showed one
  cache_error, two circuit-open cache_bypass events and three feed_database_read events.
  Production Redis configuration was not disrupted; the temporary service was removed.
- Final health returned 200; anonymous feed access returned 401; anonymous worker requests
  returned 403. Migrations 1–4 are applied, no tasks remain pending, and both services have
  min=0/max=1. Only the web runtime has access to the two Redis secrets.

These request timings were observed for one cold/warm sequence: 1,826 ms first request and
371 ms cached request. This is not an isolated latency benchmark; cold-start/connection warmup
also affect the result. The verified structural saving is two feed queries on a cache hit.

References:
- https://upstash.com/docs/redis/features/restapi
- https://upstash.com/pricing/redis
