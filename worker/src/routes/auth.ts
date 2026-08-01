import { Hono } from "hono";
import type { AppEnv } from "../types";
import { getStore } from "../db/store";
import { createToken, hashPassword, verifyPassword, extractToken, verifyToken } from "../util/auth";

const auth = new Hono<AppEnv>();

// 首次部署引导页（HTML）：浏览器访问 /api/auth/setup 即创建默认管理员，
// 账号密码均为 admin；仅当系统尚无任何用户时生效（幂等，重复访问安全）。
function setupPage(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title} · EdgeOpenList</title>
<style>
  :root{--accent:#5bb98c;--bg:#fbf7f0;--card:#fff;--text:#3a3a3a}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:var(--bg);color:var(--text);display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:var(--card);border-radius:18px;padding:34px 40px;max-width:440px;width:90%;box-shadow:0 10px 40px rgba(91,185,140,.15);text-align:center}
  h1{margin:0 0 14px;color:var(--accent);font-size:22px}
  p{margin:8px 0;line-height:1.7}
  .cred{font-size:17px;background:#f3faf6;border:1px dashed var(--accent);border-radius:12px;padding:12px;margin:16px 0}
  .cred b{color:var(--accent);font-family:ui-monospace,monospace;font-size:18px}
  .warn{color:#d98a3a;font-size:13px}
  a.btn{display:inline-block;margin-top:18px;padding:11px 26px;background:var(--accent);color:#fff;border-radius:12px;text-decoration:none;font-weight:600}
  a.btn:hover{opacity:.92}
</style></head><body><div class="card"><h1>${title}</h1>${bodyHtml}</div></body></html>`;
}

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

// 首次部署引导：浏览器访问 /api/auth/setup 即创建默认管理员（仅当无任何用户时）。
// 账号密码均为 admin，登录后请立即到后台修改密码。返回 HTML 页面便于浏览器直接打开。
auth.get("/setup", async (c) => {
  const store = getStore(c.env);
  if (await store.countUsers() > 0) {
    return c.html(
      setupPage("已完成初始化", `<p>系统已存在管理员账号，请直接 <a href="/">登录</a>。</p>`)
    );
  }
  await store.createUser("admin", await hashPassword("admin"), "admin");
  return c.html(
    setupPage(
      "初始化完成",
      `<p>管理员账号已创建：</p>
       <p class="cred">用户名 <b>admin</b> ／ 密码 <b>admin</b></p>
       <p class="warn">⚠️ 默认密码过于简单，请登录后尽快到后台修改。</p>
       <a class="btn" href="/">前往登录</a>`
    )
  );
});

// 修改密码（需登录 + 校验原密码）
auth.post("/change-password", async (c) => {
  const token = extractToken(c.req.header("Authorization"));
  const me = token ? await verifyToken(c.env, token) : null;
  if (!me) return c.json({ error: "未登录或登录已失效" }, 401);
  const { old_password, new_password } = await c.req.json<{ old_password?: string; new_password?: string }>();
  if (!new_password || new_password.length < 6) return c.json({ error: "新密码至少 6 位" }, 400);
  const store = getStore(c.env);
  const u = await store.getUserByName(me.username);
  if (!u || !(await verifyPassword(old_password || "", u.password_hash))) {
    return c.json({ error: "原密码错误" }, 403);
  }
  await store.updateUserPassword(u.id, await hashPassword(new_password));
  return c.json({ ok: true });
});

export default auth;
