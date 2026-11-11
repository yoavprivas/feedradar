import type { RedisStore } from "../../backend/feed-cache.ts";
export class FakeRedis implements RedisStore {
  now = 0;
  online = true;
  failWrites = false;
  gets = 0;
  sets = 0;
  values = new Map<string, { value: string; expiresAt: number; ttl: number }>();
  async get(key: string) {
    this.gets++;
    if (!this.online) throw new Error("private-token-must-never-be-logged");
    const entry = this.values.get(key);
    return entry && entry.expiresAt > this.now ? entry.value : null;
  }
  async set(key: string, value: string, ttl: number) {
    this.sets++;
    if (!this.online || this.failWrites)
      throw new Error("private-token-must-never-be-logged");
    this.values.set(key, { value, ttl, expiresAt: this.now + ttl * 1000 });
  }
}
export function fixtureFeed(title = "Article") {
  return {
    articles: [
      {
        id: "1",
        title,
        url: "https://fixture.example/article",
        published_at: null,
        source_name: "Fixture",
        source_id: "fixture-owner",
      },
    ],
    total: 1,
  };
}
