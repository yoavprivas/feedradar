import { randomUUID } from "node:crypto";
import type { Repository } from "./db.ts";
import type { ScanResult } from "./scanner.ts";
import { AppError } from "./types.ts";

export class ScanStore {
  constructor(private repo: Repository) {}
  async acquire(key: string, cooldownMs: number) {
    const client = await this.repo.pool.connect();
    try {
      await client.query("BEGIN");
      const control = (
        await client.query(
          "SELECT *,lease_until>now() AS busy, extract(epoch FROM (now()-last_started_at))*1000 AS elapsed FROM scan_control WHERE id=1 FOR UPDATE",
        )
      ).rows[0];
      const previous = (
        await client.query("SELECT * FROM scan_runs WHERE run_key=$1", [key])
      ).rows[0];
      if (previous?.status === "complete") {
        await client.query("COMMIT");
        return { cached: previous.result as ScanResult };
      }
      if (control.busy) throw new AppError("SCAN_IN_PROGRESS", "", 409);
      if (previous?.attempts >= 3)
        throw new AppError("SCAN_RETRY_LIMIT", "", 409);
      if (control.elapsed !== null && Number(control.elapsed) < cooldownMs)
        throw new AppError("REFRESH_COOLDOWN", "", 429);
      const owner = randomUUID();
      await client.query(
        "UPDATE scan_runs SET status='interrupted', finished_at=now() WHERE status='running'",
      );
      await client.query(
        "UPDATE scan_control SET owner=$1,lease_until=now()+interval '90 seconds',last_started_at=now() WHERE id=1",
        [owner],
      );
      await client.query(
        `INSERT INTO scan_runs(run_key,owner,status) VALUES($1,$2,'running') ON CONFLICT(run_key) DO UPDATE SET owner=$2,status='running',attempts=scan_runs.attempts+1,started_at=now(),finished_at=NULL,progress=0`,
        [key, owner],
      );
      // Retain seven days of operational records, never delete article data.
      await client.query(
        "DELETE FROM scan_runs WHERE started_at<now()-interval '7 days' AND status<>'running'",
      );
      await client.query("COMMIT");
      return { owner };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async renew(owner: string) {
    const result = await this.repo.pool.query(
      "UPDATE scan_control SET lease_until=now()+interval '90 seconds' WHERE id=1 AND owner=$1 AND lease_until>now()",
      [owner],
    );
    if (!result.rowCount) throw new AppError("SCAN_LEASE_LOST", "", 503);
  }
  async finish(owner: string, key: string, result: ScanResult | null) {
    const client = await this.repo.pool.connect();
    try {
      await client.query("BEGIN");
      const lease = await client.query(
        "UPDATE scan_control SET owner=NULL,lease_until=NULL WHERE id=1 AND owner=$1 AND lease_until>now() RETURNING id",
        [owner],
      );
      if (!lease.rowCount) throw new AppError("SCAN_LEASE_LOST", "", 503);
      await client.query(
        "UPDATE scan_runs SET status=$3,finished_at=now(),result=$4 WHERE run_key=$1 AND owner=$2",
        [key, owner, result ? "complete" : "failed", result],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async progress(owner: string, checked: number) {
    await this.repo.pool.query(
      "UPDATE scan_runs SET progress=$2 WHERE owner=$1 AND status='running'",
      [owner, checked],
    );
  }
  async status() {
    const [control, last] = await Promise.all([
      this.repo.pool.query(
        "SELECT coalesce(lease_until>now(),false) AS scanning FROM scan_control WHERE id=1",
      ),
      this.repo.pool.query(
        "SELECT finished_at,result FROM scan_runs WHERE status='complete' ORDER BY finished_at DESC LIMIT 1",
      ),
    ]);
    return {
      scanning: control.rows[0]?.scanning ?? false,
      lastFinishedAt: last.rows[0]?.finished_at ?? null,
      lastResult: last.rows[0]?.result ?? null,
    };
  }
}
