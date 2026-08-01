import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";
import { extractToken, verifyToken } from "../util/auth";
import { forbidden, unauthenticated } from "../util/errors";

// 校验 JWT，注入 c.set("user")。
// 注意：这里抛出的 401 是**唯一**允许前端清 token 跳登录页的信号，
// 所以必须带上 code = "unauthenticated"，与上游网盘故障（502）严格区分。
export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const token = extractToken(c.req.header("Authorization"));
  if (!token) throw unauthenticated("请先登录");
  const user = await verifyToken(c.env, token);
  if (!user) throw unauthenticated("登录已过期，请重新登录");
  c.set("user", user);
  await next();
});

// 管理员校验：自带 JWT 校验（不依赖前置 authMiddleware），并注入 c.set("user")
export const adminMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const token = extractToken(c.req.header("Authorization"));
  if (!token) throw unauthenticated("请先登录");
  const user = await verifyToken(c.env, token);
  if (!user) throw unauthenticated("登录已过期，请重新登录");
  // 权限不足是 403 而非 401：前端不该因此登出
  if (user.role !== "admin") throw forbidden("需要管理员权限");
  c.set("user", user);
  await next();
});
