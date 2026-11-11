import { randomUUID } from "node:crypto";
import type { Repository } from "./db.ts";
import { AppError } from "./types.ts";

export type TaskMessage = { version: 1; taskId: string };
export class TaskStore {
  constructor(readonly repo: Repository) {}

  async create(key: string, cooldownMs: number) {
    const c = await this.repo.pool.connect();
    try {
      await c.query("BEGIN");
      const control = (
        await c.query(`SELECT *, lease_until>now() AS busy,
        extract(epoch FROM(now()-last_started_at))*1000 AS elapsed
        FROM scan_control WHERE id=1 FOR UPDATE`)
      ).rows[0];
      const previous = (
        await c.query("SELECT id FROM scan_batches WHERE run_key=$1", [key])
      ).rows[0];
      if (previous) {
        await c.query("COMMIT");
        return previous.id as string;
      }
      const active = await c.query(
        "SELECT 1 FROM scan_tasks WHERE status NOT IN ('complete','dead') LIMIT 1",
      );
      if (control.busy || active.rowCount)
        throw new AppError("SCAN_IN_PROGRESS", "", 409);
      if (
        cooldownMs &&
        control.elapsed !== null &&
        Number(control.elapsed) < cooldownMs
      )
        throw new AppError("REFRESH_COOLDOWN", "", 429);
      const id = randomUUID();
      await c.query("INSERT INTO scan_batches(id,run_key) VALUES($1,$2)", [
        id,
        key,
      ]);
      const sources = await c.query("SELECT id FROM sources ORDER BY id");
      for (const source of sources.rows)
        await c.query(
          "INSERT INTO scan_tasks(id,batch_id,source_id) VALUES($1,$2,$3)",
          [randomUUID(), id, source.id],
        );
      await c.query("UPDATE scan_control SET last_started_at=now() WHERE id=1");
      // Longer than the seven-day Pub/Sub retention and one-day Scheduler retry window.
      await c.query(`DELETE FROM scan_batches b WHERE created_at<now()-interval '30 days'
        AND NOT EXISTS(SELECT 1 FROM scan_tasks t WHERE t.batch_id=b.id AND t.status NOT IN ('complete','dead'))`);
      await c.query("COMMIT");
      return id;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }

  async outbox() {
    return (
      await this.repo.pool.query(`SELECT id FROM scan_tasks
      WHERE published_at IS NULL AND status NOT IN ('complete','dead') ORDER BY id LIMIT 100`)
    ).rows;
  }
  async published(id: string) {
    await this.repo.pool.query(
      "UPDATE scan_tasks SET published_at=coalesce(published_at,now()) WHERE id=$1",
      [id],
    );
  }
  async claim(id: string) {
    const c = await this.repo.pool.connect();
    try {
      await c.query("BEGIN");
      // Serializes claims across replicas, enforcing the global two-task budget.
      await c.query("SELECT id FROM scan_control WHERE id=1 FOR UPDATE");
      const task = (
        await c.query(
          "SELECT *,lease_until>now() AS busy FROM scan_tasks WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!task) throw new AppError("UNKNOWN_TASK", "", 400);
      if (["complete", "dead"].includes(task.status)) {
        await c.query("COMMIT");
        return null;
      }
      const running = await c.query(
        "SELECT source_id FROM scan_tasks WHERE status='running' AND lease_until>now()",
      );
      if (
        task.busy ||
        running.rows.length >= 2 ||
        running.rows.some((r) => r.source_id === task.source_id)
      )
        throw new AppError("WORKER_BUSY", "", 503);
      const owner = randomUUID();
      await c.query(
        `UPDATE scan_tasks SET status='running',owner=$2,lease_until=now()+interval '90 seconds',
        attempts=attempts+1 WHERE id=$1`,
        [id, owner],
      );
      await c.query("COMMIT");
      return {
        owner,
        sourceId: task.source_id as string,
        attempt: Number(task.attempts) + 1,
      };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async renew(id: string, owner: string) {
    const r = await this.repo.pool.query(
      `UPDATE scan_tasks SET lease_until=now()+interval '90 seconds'
      WHERE id=$1 AND owner=$2 AND status='running' AND lease_until>now()`,
      [id, owner],
    );
    if (!r.rowCount) throw new AppError("SCAN_LEASE_LOST", "", 503);
  }
  async fail(id: string, owner: string, error: string) {
    const c = await this.repo.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query(
        `UPDATE scan_tasks SET status='retry',error=$3,owner=NULL,lease_until=NULL
        WHERE id=$1 AND owner=$2 AND status='running' AND lease_until>now() RETURNING source_id`,
        [id, owner, error],
      );
      if (r.rowCount)
        await c.query(
          "UPDATE sources SET last_checked_at=now(),last_error=$2 WHERE id=$1",
          [r.rows[0].source_id, error],
        );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async dead(id: string) {
    const r = await this.repo.pool.query(
      `UPDATE scan_tasks SET status='dead',finished_at=now(),owner=NULL,lease_until=NULL,
      error=coalesce(error,'DELIVERY_EXHAUSTED') WHERE id=$1 AND status NOT IN ('complete','dead')
      AND (lease_until IS NULL OR lease_until<=now()) RETURNING id`,
      [id],
    );
    if (!r.rowCount) {
      const task = (
        await this.repo.pool.query(
          "SELECT status FROM scan_tasks WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (task?.status === "running")
        throw new AppError("WORKER_BUSY", "", 503);
    }
  }
  async batch(id: string) {
    const r = (
      await this.repo.pool.query(
        `SELECT b.id,b.created_at,
      count(t.id)::int AS checked, coalesce(sum(t.added),0)::int AS added,
      count(t.id) FILTER(WHERE t.status='complete')::int AS succeeded,
      count(t.id) FILTER(WHERE t.status='dead')::int AS failed,
      count(t.id) FILTER(WHERE t.status NOT IN ('complete','dead'))::int AS pending,
      max(t.finished_at) AS finished_at FROM scan_batches b LEFT JOIN scan_tasks t ON t.batch_id=b.id
      WHERE b.id=$1 GROUP BY b.id`,
        [id],
      )
    ).rows[0];
    if (!r) throw new AppError("NOT_FOUND", "", 404);
    const { added, succeeded, failed, checked, pending } = r;
    return {
      batchId: id,
      status: pending ? ("queued" as const) : ("complete" as const),
      result: { added, succeeded, failed, checked },
      finishedAt: r.finished_at ?? r.created_at,
    };
  }
  async status() {
    // One round trip and one consistent snapshot; the database is in another region.
    const row = (
      await this.repo.pool.query(`WITH latest AS (
      SELECT id FROM scan_batches ORDER BY created_at DESC,id DESC LIMIT 1
    ), last_complete AS (
      SELECT b.id,b.created_at FROM scan_batches b WHERE NOT EXISTS(
        SELECT 1 FROM scan_tasks t WHERE t.batch_id=b.id AND t.status NOT IN ('complete','dead'))
      ORDER BY b.created_at DESC,b.id DESC LIMIT 1
    ) SELECT EXISTS(SELECT 1 FROM scan_tasks WHERE batch_id=(SELECT id FROM latest)
        AND status NOT IN ('complete','dead')) AS scanning,
      finished.finished_at,finished.result
      FROM (SELECT 1) singleton LEFT JOIN LATERAL (
        SELECT coalesce(max(t.finished_at),b.created_at) AS finished_at,
          jsonb_build_object('added',coalesce(sum(t.added),0),'checked',count(t.id),
            'succeeded',count(t.id) FILTER(WHERE t.status='complete'),
            'failed',count(t.id) FILTER(WHERE t.status='dead')) AS result
        FROM last_complete b LEFT JOIN scan_tasks t ON t.batch_id=b.id GROUP BY b.id,b.created_at
      ) finished ON true`)
    ).rows[0];
    return {
      scanning: row.scanning,
      lastFinishedAt: row.finished_at ?? null,
      lastResult: row.result ?? null,
    };
  }
}
