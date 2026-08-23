import { sign, verify } from "hono/jwt";
import type { Env, AuthUser } from "../types";
import { getSetting, setSetting } from "../db/schema";

// ---------- 密码哈希（PBKDF2-SHA256） ----------
function toB64(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function pbkdf2(password: string, salt: Uint8Array, iter: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, key, 256);
  return hex(bits);
}
const ITER = 60000;

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const h = await pbkdf2(pw, salt, ITER);
  return `pbkdf2$${ITER}$${toB64(salt)}$${h}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
    const iter = Number(parts[1]);
    if (!Number.isSafeInteger(iter) || iter < 10_000 || iter > 2_000_000) return false;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(parts[2]) || parts[2].length > 256) return false;
    if (!/^[0-9a-f]{64}$/i.test(parts[3])) return false;
    const salt = fromB64(parts[2]);
    if (salt.length < 8 || salt.length > 64) return false;
    const h = await pbkdf2(pw, salt, iter);
    return timingSafeEqual(h, parts[3]);
  } catch {
    return false;
  }
}

/** 恒定时间字符串比较，避免通过响应时间侧信道爆破哈希/分享密码。 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- JWT 密钥 ----------
// 原实现在 JWT_SECRET 缺失时回退到仓库里公开的硬编码字符串，任何人都能自签一个
// admin token 直接接管实例。这里改为：缺失时生成随机密钥并持久化到 D1，
// 保证「不配置也安全」且同一部署内稳定（多 isolate / 冷启动都拿到同一个）。
const SECRET_KEY = "jwt_secret";
let cachedSecret: string | null = null;

export async function getJwtSecret(env: Env): Promise<string> {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  if (cachedSecret) return cachedSecret;
  const db = env.DB as D1Database | undefined;
  if (!db || typeof (db as any).prepare !== "function") {
    // 无 D1（纯静态/测试场景）：退化为进程内随机密钥，重启即失效，但绝不可预测。
    cachedSecret = crypto.randomUUID() + crypto.randomUUID();
    return cachedSecret;
  }
  const existing = await getSetting(db, SECRET_KEY);
  if (existing) {
    cachedSecret = existing;
    return existing;
  }
  const generated = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  await setSetting(db, SECRET_KEY, generated);
  // 并发首启可能有多个 isolate 同时生成，以先落库的为准。
  const winner = (await getSetting(db, SECRET_KEY)) || generated;
  cachedSecret = winner;
  return winner;
}

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 天

export async function createToken(env: Env, user: AuthUser): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: String(user.id), name: user.username, role: user.role, iat: now, exp: now + SESSION_TTL };
  return await sign(payload, await getJwtSecret(env), "HS256");
}

export async function verifyToken(env: Env, token: string): Promise<AuthUser | null> {
  try {
    const p = (await verify(token, await getJwtSecret(env), "HS256")) as any;
    if (p.k) return null; // 内容令牌不能当会话令牌用
    return { id: Number(p.sub), username: p.name, role: p.role };
  } catch {
    return null;
  }
}

export function extractToken(header?: string): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

// ---------- 内容访问令牌 ----------
// 浏览器导航（window.open / <video src> / <img src> / 迅雷等下载器）无法携带
// Authorization 头，因此 /api/fs/get|raw 过去必然 401 —— 「打开文件」是 100% 坏的。
// 这里签发一个作用域极窄的短期令牌：只对指定挂载 + 指定路径有效，且不能反过来当会话令牌。
const CONTENT_TTL = 60 * 60 * 6; // 6 小时，够看完一部长视频并支持拖动进度条

export interface ContentClaim {
  mount: number;
  path: string;
}

export async function createContentToken(env: Env, claim: ContentClaim, ttl = CONTENT_TTL): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await sign({ k: "c", m: claim.mount, p: claim.path, iat: now, exp: now + ttl }, await getJwtSecret(env), "HS256");
}

export async function verifyContentToken(env: Env, token: string): Promise<ContentClaim | null> {
  try {
    const p = (await verify(token, await getJwtSecret(env), "HS256")) as any;
    if (p.k !== "c") return null;
    return { mount: Number(p.m), path: String(p.p) };
  } catch {
    return null;
  }
}
