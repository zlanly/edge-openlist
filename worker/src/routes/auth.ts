import { Hono } from "hono";
import type { AppEnv } from "../types";
import { getStore } from "../db/store";
import { createToken, hashPassword, verifyPassword } from "../util/auth";

const auth = new Hono<AppEnv>();

// 登录
auth.post("/login", async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();
  if (!username || !password) return c.json({ error: "缺少用户名或密码" }, 400);
  const user = await getStore(c.env).getUserByName(username);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: "用户名或密码错误" }, 401);
  }
  const token = await createToken(c.env, { id: user.id, username: user.username, role: user.role });
  return c.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// 登出（纯前端清 token 即可，此处仅作约定端点）
auth.post("/logout", async (c) => c.json({ ok: true }));

// 首次部署引导：创建管理员（仅当无用户时）
auth.get("/bootstrap", async (c) => {
  const secret = c.req.query("secret");
  const want = c.env.BOOTSTRAP_SECRET;
  if (!want || secret !== want) return c.json({ error: "禁止" }, 403);
  if (await getStore(c.env).countUsers() > 0) return c.json({ error: "已存在用户，禁止重复引导" }, 409);
  const username = c.req.query("username") || "admin";
  const password = c.req.query("password") || "edgeopenlist";
  await getStore(c.env).createUser(username, await hashPassword(password), "admin");
  return c.json({ ok: true, username, password });
});

export default auth;
