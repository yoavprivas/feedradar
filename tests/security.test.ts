import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  schedulerVerifier,
} from "../backend/security.ts";
import { OAuth2Client } from "google-auth-library";
import { generateKeyPairSync, sign } from "node:crypto";
import { databaseConfig } from "../backend/database-config.ts";

test("password hashes are salted and reject wrong passwords / malformed hashes", async () => {
  const hash = await hashPassword("test-password-long-enough");
  assert.notEqual(hash, await hashPassword("test-password-long-enough"));
  assert(await verifyPassword("test-password-long-enough", hash));
  assert(!(await verifyPassword("wrong", hash)));
  assert(!(await verifyPassword("anything", "broken")));
  await assert.rejects(hashPassword("short"));
});
test("remote PostgreSQL cannot downgrade certificate verification via URL options", () => {
  const remote = databaseConfig(
    "postgresql://user:example@pooler.example.com:6543/db?sslmode=no-verify",
  );
  assert.deepEqual(remote.ssl, { rejectUnauthorized: true });
  assert(!remote.connectionString?.includes("sslmode"));
  assert.equal(
    databaseConfig("postgresql://user:example@127.0.0.1/db").ssl,
    false,
  );
});
test("OIDC verifies signature, issuer, audience, expiry and verified service-account email", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const client = new OAuth2Client();
  // Replace only certificate download, exercise the real Google token verifier.
  client.getFederatedSignonCertsAsync = async () =>
    ({
      certs: {
        fixture: publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    }) as any;
  const verify = schedulerVerifier(
    "https://service.run.app",
    "scheduler@example.iam.gserviceaccount.com",
    client,
  );
  const now = Math.floor(Date.now() / 1000);
  const makeToken = (patch = {}, key = privateKey) => {
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: "fixture" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: "https://accounts.google.com",
        aud: "https://service.run.app",
        iat: now,
        exp: now + 3600,
        sub: "test-account",
        email_verified: true,
        email: "scheduler@example.iam.gserviceaccount.com",
        ...patch,
      }),
    ).toString("base64url");
    return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key).toString("base64url")}`;
  };
  assert(await verify(makeToken()));
  await assert.rejects(verify(makeToken({ aud: "https://evil.example" })));
  await assert.rejects(verify(makeToken({ iss: "https://evil.example" })));
  await assert.rejects(verify(makeToken({ iat: now - 7200, exp: now - 3600 })));
  assert.equal(await verify(makeToken({ email_verified: false })), false);
  assert.equal(
    await verify(makeToken({ email: "other@example.iam.gserviceaccount.com" })),
    false,
  );
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await assert.rejects(verify(makeToken({}, other.privateKey)));
});
