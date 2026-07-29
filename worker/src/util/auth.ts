import { sign, verify } from "hono/jwt";
import type { Env, AuthUser } from "../types";

// ---------- 密码哈希（PBKDF2-SHA256） ----------
function toB64(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...b));
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
  const [scheme, iterStr, saltB64, hash] = stored.split("$");
  if (scheme !== "pbkdf2") return false;
  const h = await pbkdf2(pw, fromB64(saltB64), Number(iterStr));
  return h === hash;
}

// ---------- JWT ----------
function secret(env: Env): string {
  return env.JWT_SECRET || "edge-openlist-default-secret";
}

export async function createToken(env: Env, user: AuthUser): Promise<string> {
  const payload = {
    sub: String(user.id),
    name: user.username,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7, // 7 天
  };
  return await sign(payload, secret(env), "HS256");
}

export async function verifyToken(env: Env, token: string): Promise<AuthUser | null> {
  try {
    const p = (await verify(token, secret(env), "HS256")) as any;
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
