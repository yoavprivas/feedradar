import type pg from "pg";
import { schemaSql } from "./db.ts";

export async function migrate(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(4310101)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const migrations = [
      schemaSql,
      `
      CREATE TABLE admin_sessions (token_hash text PRIMARY KEY, credential_version text NOT NULL, expires_at timestamptz NOT NULL);
      CREATE TABLE login_throttle (id integer PRIMARY KEY CHECK(id=1), window_start timestamptz NOT NULL, attempts integer NOT NULL);
      CREATE TABLE scan_control (id integer PRIMARY KEY CHECK(id=1), owner uuid, lease_until timestamptz, last_started_at timestamptz);
      INSERT INTO scan_control(id) VALUES(1);
      CREATE TABLE scan_runs (run_key text PRIMARY KEY, owner uuid NOT NULL, status text NOT NULL, attempts integer NOT NULL DEFAULT 1, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, result jsonb, progress integer NOT NULL DEFAULT 0);
    `,
      `CREATE TABLE scan_batches (
        id uuid PRIMARY KEY, run_key text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE scan_tasks (
        id uuid PRIMARY KEY, batch_id uuid NOT NULL REFERENCES scan_batches(id) ON DELETE CASCADE,
        source_id uuid NOT NULL, status text NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','running','retry','complete','dead')),
        owner uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
        added integer NOT NULL DEFAULT 0, error text, published_at timestamptz,
        finished_at timestamptz, UNIQUE(batch_id,source_id)
      );
      CREATE INDEX scan_tasks_outbox ON scan_tasks(batch_id) WHERE published_at IS NULL;
      CREATE INDEX scan_tasks_active ON scan_tasks(source_id,lease_until) WHERE status='running';`,
      `CREATE TABLE feed_cache_state(id integer PRIMARY KEY CHECK(id=1),revision bigint NOT NULL DEFAULT 0);
       INSERT INTO feed_cache_state(id) VALUES(1);
       CREATE INDEX scan_batches_recent ON scan_batches(created_at DESC,id DESC);`,
    ];
    for (let i = 0; i < migrations.length; i++) {
      const version = i + 1;
      if (
        (
          await client.query(
            "SELECT 1 FROM schema_migrations WHERE version=$1",
            [version],
          )
        ).rowCount
      )
        continue;
      await client.query(migrations[i]);
      await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [
        version,
      ]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
