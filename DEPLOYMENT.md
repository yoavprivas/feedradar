# FeedRadar cloud operations

## Existing environment

- App: https://feedradar-660376222507.us-central1.run.app
- GCP project: `project-43592e87-a1ec-43b7-bb4` (number `660376222507`). Do not create a replacement project or activate new billing.
- Cloud Run `feedradar`, `us-central1`: request-based CPU, 1 vCPU, 512 MiB, min 0, max 1, concurrency 8, request timeout 300 seconds.
- Supabase project `pdxumhjoltavlragfnec`, Sydney session pooler on port 5432; private `feedradar` schema and dedicated `feedradar_app` role. Public CA is in `backend/certs`; TLS hostname/certificate verification is mandatory.
- Administrator password hash and database URL are in Secret Manager. GitHub stores no Google service-account key or application password.
- External Scheduler `feedradar-hourly`, cron `28 * * * *`, UTC. This is one regular execution per hour; at most two retries, with 120–300 second backoff and a 20-minute retry window.
- `SCHEDULER_JOB_NAME` must be the short ID **`feedradar-hourly`**, not its full resource path. OIDC verifies the service-account email, issuer, signature, expiry and audience before this additional job check. [Google header documentation](https://docs.cloud.google.com/scheduler/docs/configuring/deduplicate-job-requests).
- The canonical URL above is required by the host/origin checks. Use `/api/health` for an external database health check; `/healthz` works inside the container but the public Google frontend returned 404 for that path.

## Deploy an update

1. Make changes, run focused tests and `pnpm build`. Use the isolated `TEST_DATABASE_URL`, never the production database for integration tests.
2. Commit and push to `main` only with owner authorization. GitHub CI runs unit/integration/browser tests, TypeScript/build, Docker build and container-persistence checks.
3. Wait for green CI on the exact current main commit. In GitHub Actions, open **Deploy approved revision**, choose main, paste its full 40-character SHA and enter `DEPLOY`. `CLOUD_DEPLOY_ENABLED` must be true. The workflow independently checks CI and the selected revision.
4. Verify `/api/health`, administrator login, feed contents and Scheduler results. A failed deployment is not a successful release.

The workflow builds in GitHub, uploads to the existing Artifact Registry repository and deploys Cloud Run. It does not create IAM bindings, Scheduler jobs or secret values. Workload Identity Federation is restricted to owner ID `352892435`, repository ID `1446982795`, main and the relevant environment. This account's subject uses immutable IDs:

`repo:yoavprivas@352892435/feedradar@1446982795:environment:production`

The backup identity uses environment `backup`. GitHub environments restrict deployment to main. Separate accounts are used for deploy, runtime, scheduler and backup. The deploy account has Cloud Run developer, writer access to its image repository, and permission to use the runtime account. Runtime can read only its two named secrets. Backup can read the database secret and create/read encrypted objects in its own bucket; it cannot delete them. No owner/editor role was granted to these accounts.

Repository variables required by the workflows: `GCP_PROJECT_ID`, `WIF_PROVIDER`, `DEPLOY_SERVICE_ACCOUNT`, `RUNTIME_SERVICE_ACCOUNT`, `PUBLIC_ORIGIN`, `SCHEDULER_SERVICE_ACCOUNT`, `SCHEDULER_JOB_NAME`, `CLOUD_DEPLOY_ENABLED`, `BACKUP_SERVICE_ACCOUNT`, `BACKUP_BUCKET`, `BACKUP_PUBLIC_KEY`, `CLOUD_BACKUP_ENABLED`. Public-key material is intentionally not secret; the private recovery key must never be stored in the repository or backup bucket.

## Backup and recovery

GitHub workflow **Encrypted daily database backup** runs at 03:23 UTC daily and can also be dispatched manually. Schedules can be delayed by GitHub; check workflow success, not just the cron configuration. It uses PostgreSQL 17 `pg_dump` over verified TLS, encrypts with AES-256-GCM and wraps the random data key with RSA-OAEP-SHA256. Only encrypted output is uploaded to:

`gs://feedradar-backups-project-43592e87-a1ec-43b7-bb4`

The bucket is regional Standard storage in us-central1, public access prevention is enforced, uniform access is enabled, lifecycle deletion is seven days and soft-delete retention is zero. This gives approximately a one-day recovery point when the daily run succeeds. Losing all seven days of backups cannot be recovered from this bucket.

The owner has a separate passphrase-encrypted recovery key in a private Google Drive folder. Keep the recovery passphrase outside Drive and this computer. The recovery file uses scrypt (N=32768, r=8, p=1) and AES-256-GCM. Neither the passphrase nor the unencrypted recovery key is in Google Cloud, GitHub, or this document.

To recover on another computer with Node.js 24, Python 3 and PostgreSQL 17 tools:

1. Download the encrypted recovery-key JSON from the owner's private Drive and the desired `.enc` object from Cloud Storage using the owner's authenticated account.
2. From the repository, run `python scripts/unlock-recovery.py path/to/recovery.json path/to/recovery.pem`. It asks for the passphrase with hidden input and refuses to overwrite an existing output.
3. Run `node scripts/backup-crypto.mjs decrypt path/to/database.enc path/to/recovery.pem path/to/database.dump`.
4. Have a database administrator create a NEW isolated restore database. Configure libpq credentials securely in the environment or a protected password file, then run `pg_restore --exit-on-error --no-owner --no-privileges --dbname=ISOLATED_RESTORE_DB path/to/database.dump`.
5. Verify migrations, sources, articles and relationships before deciding whether to recover production. Restoring a dump does not recreate cloud IAM or secret values. Do not overwrite production as part of a test.
6. Remove temporary decrypted dump/key files after successful verification. Keep the encrypted Drive key and its separately stored passphrase.

Changing the recovery key requires retaining the old private key until backups encrypted to it have expired. A password reset for the app is separate from the recovery passphrase.

## Costs and monitoring

Verified on 2026-11-10: the existing project is linked to the existing Free Trial billing account; Cloud Run monthly spend cap ILS 10 is Configured for this project. An ILS 20 account-wide alert budget has thresholds ILS 5/10/20. No billing upgrade or budget change was made.

Spend caps use gross estimated usage, are not instantaneous, and the Cloud Run cap does not cover supporting services. [Spend cap limitations](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps).

The built runtime image was about 92.4 MB compressed (plus small manifest metadata). Artifact Registry keeps the two most recent versions and deletes other versions older than seven days; frequent deployments can temporarily retain more images. Free allowances are shared at billing-account level: Registry 0.5 GiB-month; Secret Manager six active versions/10,000 accesses; Scheduler three jobs; eligible US regional Cloud Storage 5 GB-month. Remaining account-wide allowances and GitHub private-repository minutes must be monitored; free operation is not guaranteed. Cross-region database traffic and Internet egress can incur cost. No Cloud Build, VPC connector, load balancer or paid image scanning was enabled.

Sources: [Registry](https://cloud.google.com/artifact-registry/pricing), [Secrets](https://cloud.google.com/secret-manager/pricing), [Scheduler](https://cloud.google.com/scheduler/pricing), [Free tier](https://docs.cloud.google.com/free/docs/free-cloud-features).

Inspect Cloud Scheduler execution results and Cloud Run request/error logs for failures; inspect GitHub backup runs daily. Cloud Run min=0 can cause cold-start delay. Supabase remains on its existing Free plan; monitor database size and egress. The single-admin login rate limit is shared and can temporarily delay legitimate login after repeated failures.
