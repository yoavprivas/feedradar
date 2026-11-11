# Stage C — Pub/Sub implementation and release gate

Status, 2026-11-11: Stage C COMPLETE. Pub/Sub cloud acceptance passed first, then Redis was
deployed and cloud-verified after the owner's instruction to finish Stage C and creation of
the two Redis secrets. Production source: 29d843b7c62921ba69405c59ea4db4b2041349e3; web revision
feedradar-00007-x67, private worker feedradar-worker-00003-6dm. See [REDIS.md](REDIS.md) for the
final cache/TTL/invalidation/fallback evidence. The Pub/Sub phase evidence below is retained.

## Architecture

The web service uses `SCAN_MODE=pubsub` to publish through the real Google Pub/Sub REST
API, authenticated using Application Default Credentials / the Cloud Run runtime identity.
There are no service-account key files. `SCAN_MODE=sync` is the existing local/stage B path.
The existing hourly Cloud Scheduler job still calls the authenticated `/internal/scan`;
the manual button still calls the authenticated `/api/refresh`.

Both endpoints return HTTP 202 and `{accepted:true,batchId}` after publication. Each source
gets a stable UUID task. `GET /api/scans/:id` returns batch status and aggregate results,
behind the same administrator authentication as the feed. The current app has a single
administrator and one shared dataset, not separate user accounts. The existing UI polls
its batch every three seconds and keeps the existing busy/result presentation.

`backend/worker-index.ts` is a separate entry point in the SAME container image. Run it
with `node --import tsx backend/worker-index.ts`. It exposes only health, task and dead-letter
routes; it exposes no feed, source-management or password-login API. Deploy it as a private
Cloud Run service with request-based CPU, min=0, max=1, concurrency=2 and timeout=300 seconds.
Push requests keep CPU allocated during work; there is no detached background work after
ACK and no always-on pull subscriber. The worker reuses `Collector.collect` and repository
article writes, without rewriting discovery/parsing behavior. Initial source registration
and discovery retain their existing behavior; scheduled/manual refreshes are asynchronous.

Migration 3 adds `scan_batches` and `scan_tasks`, preserving all existing data. A transaction
creates each batch and its task outbox before publication. Publication failures return 503
and retain unpublished tasks. Each later refresh/Scheduler request flushes that outbox first.
Scheduler already retries failures; after its retry window, recovery can wait until the next
hourly invocation. There is no new permanent outbox poller or extra Scheduler job. A crash
after publication but before recording it can republish the same IDs safely.

Database claims enforce two active task leases globally and at most one per source, even
if replicas temporarily overlap. Leases last 90 seconds, renew every 20 seconds, and collection
is cancelled after 240 seconds or lost renewal. Task ownership is fenced in the same database
transaction as article writes and task completion. A stale owner cannot commit. Article URL
uniqueness remains enforced in PostgreSQL. Acknowledgment loss after commit results in a
no-op redelivery. Completed tasks ACK; terminal dead tasks ACK without being marked successful.

Non-2xx worker responses request Pub/Sub redelivery. Individual source errors stay retryable
while other source tasks can proceed. Pub/Sub's dead-letter policy, rather than the old sync
scanner's three-attempt cap, governs delivery attempts. The dead-letter status push marks
exhausted tasks `dead`; active leases cannot be overwritten by late dead-letter notifications.
Batch status `complete` means processing has ended; `result.failed` distinguishes failures.
The DL subscription retains acknowledged messages for inspection. Poison payloads log only
an error code and ACK at the DL handler; they must not create an infinite DL-processing loop.

Successful/failed completed batches are retained for 30 days, longer than the planned
seven-day broker retention. Pending records are not silently removed. If IAM/configuration
is broken long enough for broker messages to expire, an operator must investigate/recover
the pending batch; dead-letter forwarding is best-effort, not a delivery guarantee.

Logs: `scan_queued`, `publish_failed`, `task_started`, `task_complete`, `task_failed`,
`task_duplicate`, `task_dead_letter`, `dead_letter_invalid`, `worker_request_failed`.
They contain task/source IDs, attempt numbers and safe error codes, never credential values.

## Cloud configuration — deployed after explicit owner approval

Use ONLY existing project `project-43592e87-a1ec-43b7-bb4`, number `660376222507`, region
`us-central1`. No billing upgrade, VPC connector, Memorystore, load balancer or fixed-cost
resource. The owner reports Pub/Sub API already enabled and Upstash Free prepared in GCP
us-central1 as `feedradar-cache`; credentials stay in the owner's password manager.

Resources:

- Topic `feedradar-scans`, message storage policy restricted to us-central1.
- Topic `feedradar-dead`, same region policy.
- Main push subscription `feedradar-worker`: endpoint WORKER_ORIGIN + `/internal/tasks`,
  OIDC audience WORKER_ORIGIN, dedicated push account, ACK deadline 300 seconds, seven-day
  message retention, retry minimum 60 / maximum 600 seconds, dead topic `feedradar-dead`,
  initial max delivery attempts 5. The count is approximate and also includes delivery
  failures before collection. Check capacity/backlog behavior during cloud validation;
  increase the attempt allowance if normal backlog is being dead-lettered. Disable automatic
  subscription expiration so idle use does not delete the subscription.
- Dead-letter push subscription `feedradar-dead-status`: endpoint WORKER_ORIGIN +
  `/internal/dead-letter`, same OIDC account/audience, seven-day retention WITH acknowledged
  message retention, ACK deadline 60, retry 60–600 seconds, no subscription expiration.
  No dead-letter loop back into the main topic. Inspect retained messages before any replay.
- Private Cloud Run `feedradar-worker`: same image as web; 1 vCPU, 512 MiB, min=0, max=1,
  concurrency=2, timeout=300, request-based CPU. Worker reads only the existing database
  URL secret and public CA file; it does not receive the administrator password hash.
- Keep the existing web service and Scheduler resources. Switch only web `SCAN_MODE` to
  `pubsub` once the worker, subscriptions and IAM are verified.

IAM (resource-level, no Owner/Editor grants):

- Existing web runtime identity: `roles/pubsub.publisher` on `feedradar-scans` only.
- New `feedradar-worker` runtime service account: `roles/secretmanager.secretAccessor`
  on `feedradar-database-url` only. No Pub/Sub publishing or subscribing role is required.
- Existing deployment identity: permission to act as that worker runtime account (service
  account user on that account); retain existing narrowly scoped deploy/image permissions.
- New `feedradar-push` service account: `roles/run.invoker` on the private worker only.
- Google-managed Pub/Sub service agent
  `service-660376222507@gcp-sa-pubsub.iam.gserviceaccount.com`: publisher on the dead topic,
  subscriber on the main subscription (required for DL forwarding/attempt tracking), token
  creator on the dedicated push service account for OIDC token issuance.
- Owner/operator applies IAM separately. Workflow does not grant IAM or publish secrets.
  Verify the worker has no `allUsers` or `allAuthenticatedUsers` binding and its IAM invoker
  check is enabled before attaching real messages. In-app verification also validates JWT
  signature, expiry, issuer, audience and the verified dedicated push-account email.

## GitHub variables and staged release

Keep all existing deployment approvals, WIF restrictions and exact-SHA CI gate. Add these
nonsecret repository variables only when approved:

| Variable | Value |
| --- | --- |
| `WORKER_ENABLED` | `true` to deploy worker before web; empty/false retains stage B deployment |
| `PUBSUB_ENABLED` | `true` only after worker/IAM/subscriptions are verified |
| `PUBSUB_TOPIC` | `projects/project-43592e87-a1ec-43b7-bb4/topics/feedradar-scans` |
| `WORKER_SERVICE_ACCOUNT` | `feedradar-worker@project-43592e87-a1ec-43b7-bb4.iam.gserviceaccount.com` |
| `PUBSUB_PUSH_SERVICE_ACCOUNT` | `feedradar-push@project-43592e87-a1ec-43b7-bb4.iam.gserviceaccount.com` |
| `WORKER_ORIGIN` | The actual HTTPS worker service origin, without trailing slash |
| `PUBSUB_SUBSCRIPTION` | `projects/project-43592e87-a1ec-43b7-bb4/subscriptions/feedradar-worker` |
| `PUBSUB_DEAD_SUBSCRIPTION` | `projects/project-43592e87-a1ec-43b7-bb4/subscriptions/feedradar-dead-status` |

1. Obtain explicit approval for the reviewed changes, push, resource/IAM creation and cloud
   acceptance tests. Run CI on the exact pushed revision and require success before release.
2. Create identities/topics and scoped permissions. Bootstrap the worker with the same
   approved image and its environment while leaving the web in sync mode. Obtain its actual
   origin from Cloud Run; a provisional audience may be used ONLY for bootstrap without
   subscriptions. Update WORKER_ORIGIN to the returned origin. The workflow refuses to change
   the web when that value differs from the deployed worker URL.
3. Bind push invoker permission and configure both subscriptions using that actual origin.
   Verify private IAM, token audience, DL forwarding grants and acknowledged DL retention.
4. Deploy with WORKER_ENABLED=true, PUBSUB_ENABLED=false. Exercise a controlled task through
   actual Pub/Sub and inspect its committed result and ACK. Migration 3 may already have run
   on worker startup; it is additive and compatible with the currently running stage B app.
5. During activation, pause the existing Scheduler briefly, wait for any old synchronous scan
   to finish, activate PUBSUB_ENABLED=true using the approved deployment workflow, ensure only
   the new web revision receives traffic, then restore Scheduler. Do not run old synchronous
   scans and the asynchronous worker together during rollout/rollback.
6. Validate manual/automatic delivery, real Pub/Sub retry and DL routing, and UI state. Record
   revision names, message/task IDs, attempts and CI/deploy links in the verification report.
7. Only after Pub/Sub acceptance, implement Redis, securely provision its secrets, and request
   approval for the Redis deployment/actual cache acceptance tests.

Accepted Pub/Sub evidence: CI https://github.com/yoavprivas/feedradar/actions/runs/42985842064;
activation deployment https://github.com/yoavprivas/feedradar/actions/runs/42986164156.
Web revision feedradar-00006-d92; private worker feedradar-worker-00002-btc. Manual batch
39c1a798-b650-444c-a8bc-39aa41c240ed processed both sources and added eight articles. Actual
Scheduler batch 11e1ad3d-ac37-4b1e-8f36-7149c84ced31, key scheduled:2026-11-11T08:28:00.000Z,
processed both sources and added one article. All 218 original articles and original sources
were preserved; the final observed count was 227. Scheduler is enabled with 28 * * * * UTC.

An isolated temporary cloud worker/schema verified concurrency two, successful broker retry
on attempt two, no-op duplicate delivery, and actual forwarding after five failures. The DL
message was pulled/inspected with CloudPubSubDeadLetterSourceDeliveryCount=5. Temporary test
services/topics/subscriptions/schema/role/secret were removed; production resources remained.
The test retry policy was accelerated to 10–20 seconds for the last failure attempts;
production remains 60–600 seconds. Forced early Scheduler execution returned 400 during
verification; later scheduled-time execution succeeded. Do not treat a forced request without
an accepted schedule-time header as proof of automatic operation.

Rollback: pause Scheduler and new manual requests, let in-flight task leases finish or expire,
stop/drain Pub/Sub delivery, then restore sync mode or the prior web revision. Preserve tasks,
articles and additive migration tables; do not roll back by deleting production data. Re-enable
Scheduler after verifying no async work can overlap the synchronous scanner.

## Verification gates

Local commands (use only TEST_DATABASE_URL, never production):

```powershell
pnpm test
pnpm test:integration
pnpm build
pnpm test:browser
$env:BROWSER_SCAN_MODE='pubsub'
pnpm test:browser
```

Integration tests use real local PostgreSQL transactions, HTTP endpoints, and a simulated
publisher/delivery. Browser queued tests simulate transport and exercise actual React polling.
Unit tests inspect the REST publish request and response handling with an injected requester.
These tests do NOT prove cloud IAM, broker retries, push-envelope compatibility or DL forwarding.
CI also runs the existing Docker build/persistence smoke test and both browser modes.

Cloud acceptance must include: actual manual + hourly Scheduler task creation, actual private
worker invocation, two concurrent source tasks under the limit, duplicate delivery after commit,
transient failure followed by successful broker redelivery, repeated failure forwarded to DL
with final failed UI state, retained DL inspection, anonymous rejection, and preserved sources/
articles. Use an isolated fixture/test schema and dedicated validation subscriptions for fault
injection; do not break production sources or expose production credentials in logs.

Costs: target zero incremental charge at this workload, not a guarantee. Pub/Sub includes
10 GiB monthly basic delivery throughput per billing account. Cloud Run is usage-based with
shared free allowances; network/logging/Secret Manager/Registry/retained messages can cost money.
No always-on worker or new Scheduler job is introduced. Existing spend-cap coverage does not
extend automatically to supporting services. Monitor backlog and errors to avoid retry storms.

Primary references:
- https://docs.cloud.google.com/pubsub/docs/reference/rest/v1/projects.topics/publish
- https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions
- https://docs.cloud.google.com/pubsub/docs/dead-letter-topics
- https://docs.cloud.google.com/pubsub/docs/subscription-properties
- https://docs.cloud.google.com/run/docs/tutorials/pubsub
- https://cloud.google.com/pubsub/pricing
- https://cloud.google.com/run/pricing
