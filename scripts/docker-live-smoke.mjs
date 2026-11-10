// Optional network test, separate from deterministic CI. Operates only on a new test source.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";

const base = "http://127.0.0.1:4311";
const url = process.argv[2] ?? "https://www.ynet.co.il";
const compose = (...args) => execFileSync("docker", ["compose", "--env-file", ".env.docker", ...args], { encoding: "utf8" });
// Container recreation invalidates pooled HTTP sockets. Retry only read requests.
async function readJson(path) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      return await response.json();
    } catch (error) {
      if (attempt >= 9) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}
const state = async () => (await (await fetch(base + "/api/state")).json());
const feed = async () => {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const data = await readJson(`/api/feed?limit=100&offset=${offset}`);
    rows.push(...data.articles);
    if (rows.length >= data.total) return rows;
  }
};
assert(!(await state()).sources.some(source => new URL(source.site_url).hostname === new URL(url).hostname), "Use a source not already followed in Docker; existing sources are never removed by this test.");
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, headless: true });
let addedId;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base);
  await page.getByRole("button", { name: "ניהול אתרים" }).click();
  await page.getByLabel("כתובת האתר").fill(url);
  const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/sources") && response.request().method() === "POST", { timeout: 180000 });
  await page.getByRole("button", { name: "הוספת אתר", exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 201, await response.text());
  const added = await response.json();
  addedId = added.id;
  assert(added.added > 0, "Real source must produce articles");
  assert.equal(added.collectionStatus, "ready");
  await page.getByRole("button", { name: "חזרה לפיד", exact: true }).click();
  await page.locator(".article-title").first().waitFor();
  await mkdir("test-results", { recursive: true });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: `test-results/docker-live-${width}.png`, fullPage: true });
  }
  // Respect the persisted refresh cooldown established by the startup scan.
  const last = (await state()).lastFinishedAt;
  if (last) await new Promise(resolve => setTimeout(resolve, Math.max(0, 61000 - (Date.now() - Date.parse(last)))));
  const refreshed = await fetch(base + "/api/refresh", { method: "POST", headers: { "Content-Type": "application/json", "X-FeedRadar-Request": "1" }, body: "{}" });
  assert.equal(refreshed.status, 200);
  const scan = await refreshed.json();
  assert(scan.succeeded > 0);
  const before = await feed();
  const original = before.filter(article => article.source_id === addedId);
  assert(original.length > 0);
  assert.equal(new Set(original.map(article => article.url)).size, original.length);
  const container = compose("ps", "-q", "app").trim();
  compose("stop", "app");
  const exit = execFileSync("docker", ["inspect", container, "--format", "{{.State.ExitCode}}"], { encoding: "utf8" }).trim();
  assert.equal(exit, "0", "SIGTERM must exit gracefully, without timeout or SIGKILL");
  compose("up", "-d", "--force-recreate", "--wait");
  const after = await feed();
  const identities = new Set(after.map(article => `${article.id}:${article.url}`));
  assert(original.every(article => identities.has(`${article.id}:${article.url}`)));
  await page.reload();
  await page.locator(".article-title").first().waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ source: new URL(url).hostname, initialArticles: added.added, refresh: scan, preservedArticles: original.length, gracefulExit: Number(exit), browserWidths: [390, 1440], pageErrors: errors.length }));
} finally {
  await browser.close();
  if (addedId) {
    const response = await fetch(base + "/api/sources/" + addedId, { method: "DELETE", headers: { "X-FeedRadar-Request": "1" } });
    assert.equal(response.status, 204, "Remove only this test source");
  }
}
