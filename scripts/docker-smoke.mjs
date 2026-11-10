import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const compose = (...args) =>
  execFileSync("docker", ["compose", "--env-file", ".env.docker", ...args], {
    encoding: "utf8",
  });
const base = "http://127.0.0.1:4311";
async function ready() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Container did not become ready");
}
await ready();
assert.notEqual(compose("exec", "-T", "app", "id", "-u").trim(), "0");
assert.match(await (await fetch(base)).text(), /FeedRadar/);
const count = async () =>
  (await (await fetch(base + "/api/feed")).json()).total;
const id = "43100000-0000-4000-8000-000000000001";
const sql = `INSERT INTO sources(id,name,site_url,collection_url,method) VALUES('${id}','Docker smoke fixture','https://docker-smoke.invalid/','https://docker-smoke.invalid/feed','rss') ON CONFLICT DO NOTHING; INSERT INTO articles(source_id,title,url) VALUES('${id}','Persistence fixture','https://docker-smoke.invalid/article') ON CONFLICT DO NOTHING;`;
compose(
  "exec",
  "-T",
  "db",
  "psql",
  "-U",
  "feedradar",
  "-d",
  "feedradar_docker",
  "-v",
  "ON_ERROR_STOP=1",
  "-c",
  sql,
);
const before = await count();
assert(before > 0);
compose("up", "-d", "--force-recreate", "--wait");
await ready();
assert.equal(await count(), before);
// Remove only the fixture created by this script through the normal application API.
const removed = await fetch(base + "/api/sources/" + id, {
  method: "DELETE",
  headers: { "X-FeedRadar-Request": "1" },
});
assert.equal(removed.status, 204);
console.log(
  "Docker smoke passed: non-root, UI/API, database persistence after container recreation.",
);
