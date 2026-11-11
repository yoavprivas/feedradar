import pg from "pg";
import { randomUUID } from "node:crypto";
import { AppError, type Discovered, type Entry, type Source } from "./types.ts";
import { migrate } from "./migrations.ts";
import type { FeedCache } from "./feed-cache.ts";

export const schemaSql = `
CREATE TABLE IF NOT EXISTS sources (
 id uuid PRIMARY KEY, name text NOT NULL, site_url text NOT NULL UNIQUE,
 collection_url text NOT NULL UNIQUE, method text NOT NULL CHECK(method IN ('rss','jsonfeed','wordpress','html')),
 created_at timestamptz NOT NULL DEFAULT now(), last_checked_at timestamptz,
 last_success_at timestamptz, last_error text
);
CREATE TABLE IF NOT EXISTS articles (
 id bigserial PRIMARY KEY, source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
 title text NOT NULL, url text NOT NULL, published_at timestamptz,
 discovered_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_id,url)
);
CREATE INDEX IF NOT EXISTS articles_chronological ON articles (published_at DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS articles_source ON articles (source_id);
`;
export class Repository {
  constructor(
    public pool: pg.Pool,
    private cache?: FeedCache,
  ) {}
  get cacheEnabled() {
    return !!this.cache;
  }
  async feedRevision(): Promise<string> {
    return (
      await this.pool.query(
        "SELECT revision::text FROM feed_cache_state WHERE id=1",
      )
    ).rows[0].revision;
  }
  async migrate() {
    await migrate(this.pool);
  }
  async sources(): Promise<Source[]> {
    const result = await this.pool.query(
      `SELECT s.*, (SELECT count(*)::int FROM articles a WHERE a.source_id=s.id) AS article_count,
       CASE WHEN s.last_error IS NOT NULL THEN 'error' WHEN s.last_success_at IS NULL THEN 'pending'
       WHEN EXISTS(SELECT 1 FROM articles a WHERE a.source_id=s.id) THEN 'ready' ELSE 'empty' END AS collection_status
       FROM sources s ORDER BY s.created_at, s.id`,
    );
    return result.rows;
  }
  async source(id: string): Promise<Source | undefined> {
    return (await this.pool.query("SELECT * FROM sources WHERE id=$1", [id]))
      .rows[0];
  }
  async hasSource(url: string) {
    return (
      (
        await this.pool.query(
          "SELECT 1 FROM sources WHERE site_url=$1 OR collection_url=$1",
          [url],
        )
      ).rowCount! > 0
    );
  }
  private async writeEntries(
    client: pg.PoolClient,
    sourceId: string,
    list: Entry[],
  ) {
    let added = 0;
    for (const item of list) {
      const result = await client.query(
        "INSERT INTO articles(source_id,title,url,published_at) VALUES($1,$2,$3,$4) ON CONFLICT(source_id,url) DO NOTHING",
        [sourceId, item.title, item.url, item.publishedAt],
      );
      added += result.rowCount ?? 0;
      // Fill a formerly absent publication date only when the publisher later supplies it.
      if (!result.rowCount && item.publishedAt)
        await client.query(
          "UPDATE articles SET published_at=$3 WHERE source_id=$1 AND url=$2 AND published_at IS NULL",
          [sourceId, item.url, item.publishedAt],
        );
    }
    return added;
  }
  async addSource(discovery: Discovered) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const id = randomUUID();
      await client.query(
        "INSERT INTO sources(id,name,site_url,collection_url,method) VALUES($1,$2,$3,$4,$5)",
        [
          id,
          discovery.name,
          discovery.siteUrl,
          discovery.collectionUrl,
          discovery.method,
        ],
      );
      await client.query(
        "UPDATE feed_cache_state SET revision=revision+1 WHERE id=1",
      );
      await client.query("COMMIT");
      return { id };
    } catch (e: any) {
      await client.query("ROLLBACK");
      if (e.code === "23505") throw new AppError("DUPLICATE_SITE", "", 409);
      throw e;
    } finally {
      client.release();
    }
  }
  async saveScan(
    id: string,
    list: Entry[],
    owner?: string,
    task?: { id: string; owner: string },
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (task) {
        const lease = await client.query(
          "SELECT 1 FROM scan_tasks WHERE id=$1 AND owner=$2 AND source_id=$3 AND status='running' AND lease_until>now() FOR UPDATE",
          [task.id, task.owner, id],
        );
        if (!lease.rowCount) throw new AppError("SCAN_LEASE_LOST", "", 503);
      }
      if (owner) {
        const lease = await client.query(
          "SELECT 1 FROM scan_control WHERE id=1 AND owner=$1 AND lease_until>now() FOR UPDATE",
          [owner],
        );
        if (!lease.rowCount) throw new AppError("SCAN_LEASE_LOST", "", 503);
      }
      const source = await client.query(
        "SELECT id FROM sources WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (!source.rowCount) {
        if (task)
          await client.query(
            "UPDATE scan_tasks SET status='complete',finished_at=now(),owner=NULL,lease_until=NULL WHERE id=$1",
            [task.id],
          );
        await client.query("COMMIT");
        return 0;
      }
      const added = await this.writeEntries(client, id, list);
      await client.query(
        "UPDATE sources SET last_checked_at=now(),last_success_at=now(),last_error=NULL WHERE id=$1",
        [id],
      );
      if (task)
        await client.query(
          "UPDATE scan_tasks SET status='complete',added=$2,finished_at=now(),owner=NULL,lease_until=NULL,error=NULL WHERE id=$1",
          [task.id, added],
        );
      // Commit the generation with the data, even when Redis is unavailable or absent on the worker.
      await client.query(
        "UPDATE feed_cache_state SET revision=revision+1 WHERE id=1",
      );
      await client.query("COMMIT");
      return added;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async failed(id: string, code: string, owner?: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (
        owner &&
        !(
          await client.query(
            "SELECT 1 FROM scan_control WHERE id=1 AND owner=$1 AND lease_until>now() FOR UPDATE",
            [owner],
          )
        ).rowCount
      )
        throw new AppError("SCAN_LEASE_LOST", "", 503);
      await client.query(
        "UPDATE sources SET last_checked_at=now(),last_error=$2 WHERE id=$1",
        [id, code],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async remove(id: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const removed =
        (await client.query("DELETE FROM sources WHERE id=$1", [id]))
          .rowCount! > 0;
      if (removed)
        await client.query(
          "UPDATE feed_cache_state SET revision=revision+1 WHERE id=1",
        );
      await client.query("COMMIT");
      return removed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async feed(limit = 50, offset = 0, revision?: string) {
    if (!this.cache) return this.feedFromDatabase(limit, offset);
    return this.cache.read(
      revision ?? (await this.feedRevision()),
      limit,
      offset,
      () => this.feedFromDatabase(limit, offset),
    );
  }
  private async feedFromDatabase(limit: number, offset: number) {
    if (this.cache)
      console.log(
        JSON.stringify({ event: "feed_database_read", limit, offset }),
      );
    const [items, count] = await Promise.all([
      this.pool.query(
        `SELECT a.id::text,a.title,a.url,a.published_at,s.name AS source_name,s.id AS source_id FROM articles a JOIN sources s ON a.source_id=s.id ORDER BY a.published_at DESC NULLS LAST,a.id DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      this.pool.query("SELECT count(*)::int AS count FROM articles"),
    ]);
    return { articles: items.rows, total: count.rows[0].count };
  }
}
