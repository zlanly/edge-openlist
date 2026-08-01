import { Hono, type Context } from "hono";
import type { AppEnv, Env } from "../types";
import { getStore } from "../db/store";
import { createToken, hashPassword, verifyPassword } from "../util/auth";
import { authMiddleware } from "../middleware/auth";
import { badCredentials, badRequest, forbidden, rateLimited } from "../util/errors";

const auth = new Hono<AppEnv>();

// ---------- 登录限流 ----------
// 免费档没有 WAF 速率规则可用，登录接口每次都要跑 6 万轮 PBKDF2，
// 被人拿字典打几百次就能把 Worker 的 CPU 预算耗光 —— 表现为全站「无响应」。
// 这里用 KV 做一个廉价的滑动计数：同一 IP 15 分钟内最多 10 次失败。
const LOGIN_WINDOW_S = 15 * 60;
const LOGIN_MAX_FAILS = 10;

function loginKey(c: Context<AppEnv>): string {
  const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || "unknown";
  return `login_fail:${ip}`;
}

async function assertLoginAllowed(c: Context<AppEnv>): Promise<void> {
  const kv = c.env.KV;
  if (!kv || typeof kv.get !== "function") return; // 未绑定 KV 时不阻断登录
  const n = Number((await kv.get(loginKey(c))) || 0);
  if (n >= LOGIN_MAX_FAILS) {
    throw rateLimited("登录失败次数过多，请 15 分钟后再试");
  }
}

async function recordLoginFail(env: Env, c: Context<AppEnv>): Promise<void> {
  const kv = env.KV;
  if (!kv || typeof kv.put !== "function") return;
  const key = loginKey(c);
  const n = Number((await kv.get(key)) || 0) + 1;
  await kv.put(key, String(n), { expirationTtl: LOGIN_WINDOW_S });
}

// 首次部署引导页（HTML）：浏览器访问 /setup（或 /api/auth/setup）即创建默认管理员，
// 账号密码均为 admin；仅当系统尚无任何用户时生效（幂等，重复访问安全）。
function setupPage(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title} · EdgeOpenList</title>
<style>
  :root{--accent:#5bb98c;--bg:#fbf7f0;--card:#fff;--text:#3a3a3a}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:var(--bg);color:var(--text);display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
  .card{background:var(--card);border-radius:18px;padding:34px 40px;max-width:460px;width:100%;box-shadow:0 10px 40px rgba(91,185,140,.15);text-align:center}
  h1{margin:0 0 14px;color:var(--accent);font-size:22px}
  p{margin:8px 0;line-height:1.7}
  .cred{font-size:17px;background:#f3faf6;border:1px dashed var(--accent);border-radius:12px;padding:12px;margin:16px 0}
  .cred b{color:var(--accent);font-family:ui-monospace,monospace;font-size:18px}
  .warn{color:#d98a3a;font-size:13px}
  a.btn{display:inline-block;margin-top:18px;padding:11px 26px;background:var(--accent);color:#fff;border-radius:12px;text-decoration:none;font-weight:600}
  a.btn:hover{opacity:.92}
  code{background:#f3faf6;padding:2px 6px;border-radius:6px;font-family:ui-monospace,monospace}
</style></head><body><div class="card"><h1>${title}</h1>${bodyHtml}</div></body></html>`;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// 首次部署引导：创建默认管理员（仅当无任何用户时）。浏览器访问 /setup 触发。
// 若尚未绑定 D1，返回清晰 HTML 引导去控制台加 DB，而不是裸抛错。
export async function setupHandler(c: Context<AppEnv>) {
  if (!c.env.DB || typeof (c.env.DB as any).prepare !== "function") {
    return html(
      setupPage(
        "尚未绑定 D1",
        `<p>检测到本 Worker <b>未绑定 D1 数据库</b>，无法初始化管理员。</p>
         <p>请到 Cloudflare 控制台：<br/><code>Worker → Settings → Bindings → Add → D1（绑定名 DB）</code><br/>保存后会自动重新部署，然后重新访问本页面即可。</p>
         <a class="btn" href="/">返回首页</a>`
      )
    );
  }
  const store = getStore(c.env);
  if (await store.countUsers() > 0) {
    return html(setupPage("已完成初始化", `<p>系统已存在管理员账号，请直接 <a href="/">登录</a>。</p>`));
  }
  await store.createUser("admin", await hashPassword("admin"), "admin");
  return html(
    setupPage(
      "初始化完成",
      `<p>管理员账号已创建：</p>
       <p class="cred">用户名 <b>admin</b> ／ 密码 <b>admin</b></p>
       <p class="warn">⚠️ 默认密码过于简单，请登录后尽快到后台修改。</p>
       <a class="btn" href="/">前往登录</a>`
    )
  );
}

// 探测是否需要初始化（公开，供登录页判断是否显示「一键初始化」）
export async function needsSetup(c: Context<AppEnv>) {
  if (!c.env.DB || typeof (c.env.DB as any).prepare !== "function") {
    return c.json({ needed: false, reason: "no-d1" });
  }
  const store = getStore(c.env);
  return c.json({ needed: (await store.countUsers()) === 0 });
}

// 登录
auth.post("/login", async (c) => {
  let body: { username?: string; password?: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
  const username = (body.username || "").trim();
  const password = body.password || "";
  if (!username || !password) throw badRequest("请输入用户名和密码");
  if (username.length > 64 || password.length > 256) throw badRequest("用户名或密码过长");

  await assertLoginAllowed(c);

  const user = await getStore(c.env).getUserByName(username);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    c.executionCtx?.waitUntil?.(recordLoginFail(c.env, c));
    // code = bad_credentials，与「会话过期」区分，前端不会因此触发登出重定向
    throw badCredentials();
  }
  const token = await createToken(c.env, { id: user.id, username: user.username, role: user.role });
  return c.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// 登出（纯前端清 token 即可，此处仅作约定端点）
auth.post("/logout", async (c) => c.json({ ok: true }));

auth.get("/setup", setupHandler);
auth.get("/needs-setup", needsSetup);

// 修改密码（需登录 + 校验原密码）
auth.post("/change-password", authMiddleware, async (c) => {
  const me = c.get("user")!;
  let body: { old_password?: string; new_password?: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
  const { old_password, new_password } = body;
  if (!new_password || new_password.length < 6) throw badRequest("新密码至少 6 位");
  if (new_password.length > 256) throw badRequest("新密码过长");
  const store = getStore(c.env);
  const u = await store.getUserByName(me.username);
  // 原密码错误是 403（权限不足），不是 401 —— 否则前端会把用户踢回登录页
  if (!u || !(await verifyPassword(old_password || "", u.password_hash))) {
    throw forbidden("原密码错误");
  }
  await store.updateUserPassword(u.id, await hashPassword(new_password));
  return c.json({ ok: true });
});

// 当前登录用户（供前端刷新后恢复 user，避免管理员按钮在刷新后消失）
auth.get("/me", authMiddleware, async (c) => {
  return c.json({ user: c.get("user") });
});

export default auth;
