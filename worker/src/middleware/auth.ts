import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";
import { extractToken, verifyToken } from "../util/auth";

// 校验 JWT，注入 c.set("user")
export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const token = extractToken(c.req.header("Authorization"));
  if (!token) return c.json({ error: "未登录" }, 401);
  const user = await verifyToken(c.env, token);
  if (!user) return c.json({ error: "登录已过期" }, 401);
  c.set("user", user);
  await next();
});

// 管理员校验（需先经过 authMiddleware）
export const adminMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (!user || user.role !== "admin") return c.json({ error: "需要管理员权限" }, 403);
  await next();
});
