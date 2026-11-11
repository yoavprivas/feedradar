import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Express, Request, Response } from "express";
import type { Repository } from "./db.ts";
import { AppError } from "./types.ts";
import { OAuth2Client } from "google-auth-library";

const derive = promisify(scrypt);
export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export async function hashPassword(password: string) {
  if (password.length < 16 || password.length > 256)
    throw new Error("Use a password of 16–256 characters");
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${((await derive(password, salt, 64)) as Buffer).toString("hex")}`;
}
export function validPasswordHash(hash: string) {
  return /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash);
}
export async function verifyPassword(password: string, hash: string) {
  if (!validPasswordHash(hash)) return false;
  const [, salt, expected] = hash.split(":");
  return timingSafeEqual(
    (await derive(password, salt, 64)) as Buffer,
    Buffer.from(expected, "hex"),
  );
}
export type SecurityOptions = {
  schedulerMode?: string;
  publicOrigin?: string;
  authMode?: string;
  passwordHash?: string;
  schedulerAudience?: string;
  schedulerEmail?: string;
  schedulerJob?: string;
  verifyScheduler?: (token: string) => Promise<boolean>;
};
export function schedulerVerifier(
  audience: string,
  email: string,
  client = new OAuth2Client(),
) {
  return async (token: string) => {
    const ticket = await client.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    return (
      !!payload &&
      ["accounts.google.com", "https://accounts.google.com"].includes(
        payload.iss,
      ) &&
      payload.email_verified === true &&
      payload.email === email
    );
  };
}
export function installAuth(
  app: Express,
  repo: Repository,
  options: SecurityOptions,
) {
  const enabled = options.authMode === "password";
  if (enabled && !validPasswordHash(options.passwordHash ?? ""))
    throw new Error("Invalid ADMIN_PASSWORD_HASH");
  const secure = options.publicOrigin?.startsWith("https://") ?? false;
  const name = secure ? "__Host-feedradar" : "feedradar-local";
  const version = digest(options.passwordHash ?? "local");
  const token = (req: Request) => {
    const value = req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${name}=`))
      ?.slice(name.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : "";
  };
  const authenticated = async (req: Request, res?: Response) => {
    if (!enabled) return true;
    if (!token(req)) return false;
    // Include the generation in the existing auth query: a cache hit adds no feed DB queries.
    const result = await repo.pool.query(
      repo.cacheEnabled
        ? "SELECT 1,(SELECT revision::text FROM feed_cache_state WHERE id=1) AS feed_revision FROM admin_sessions WHERE token_hash=$1 AND credential_version=$2 AND expires_at>now()"
        : "SELECT 1 FROM admin_sessions WHERE token_hash=$1 AND credential_version=$2 AND expires_at>now()",
      [digest(token(req)), version],
    );
    if (res && result.rows[0]?.feed_revision)
      res.locals.feedRevision = result.rows[0].feed_revision;
    return !!result.rowCount;
  };
  app.get("/api/auth/session", async (req, res) =>
    res.json({ required: enabled, authenticated: await authenticated(req) }),
  );
  app.post("/api/auth/login", async (req, res) => {
    if (!enabled) {
      res.json({ authenticated: true });
      return;
    }
    if (
      typeof req.body?.password !== "string" ||
      req.body.password.length > 256
    )
      throw new AppError("INVALID_INPUT");
    // Global persisted limit is deliberate for a single administrator; no proxy-IP trust.
    const budget = await repo.pool
      .query(`INSERT INTO login_throttle VALUES(1, now(), 1)
      ON CONFLICT(id) DO UPDATE SET attempts=CASE WHEN login_throttle.window_start<now()-interval '15 minutes' THEN 1 ELSE login_throttle.attempts+1 END,
      window_start=CASE WHEN login_throttle.window_start<now()-interval '15 minutes' THEN now() ELSE login_throttle.window_start END RETURNING attempts`);
    if (budget.rows[0].attempts > 10) {
      res.setHeader("Retry-After", "900");
      throw new AppError("LOGIN_RATE_LIMIT", "", 429);
    }
    if (!(await verifyPassword(req.body.password, options.passwordHash!)))
      throw new AppError("UNAUTHORIZED", "", 401);
    const session = randomBytes(32).toString("hex");
    await repo.pool.query(
      "DELETE FROM admin_sessions WHERE expires_at<=now() OR credential_version<>$1",
      [version],
    );
    await repo.pool.query(
      "INSERT INTO admin_sessions VALUES($1,$2,now()+interval '12 hours')",
      [digest(session), version],
    );
    res.cookie(name, session, {
      httpOnly: true,
      secure,
      sameSite: "strict",
      path: "/",
      maxAge: 12 * 3600000,
    });
    res.json({ authenticated: true });
  });
  app.post("/api/auth/logout", async (req, res) => {
    await repo.pool.query("DELETE FROM admin_sessions WHERE token_hash=$1", [
      digest(token(req)),
    ]);
    res.clearCookie(name, {
      httpOnly: true,
      secure,
      sameSite: "strict",
      path: "/",
    });
    res.status(204).end();
  });
  app.use("/api", async (req, res, next) => {
    if (!(await authenticated(req, res)))
      throw new AppError("UNAUTHORIZED", "", 401);
    next();
  });
}
