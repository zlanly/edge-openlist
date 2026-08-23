import { Hono, type Context } from "hono";
import type { AppEnv, Env } from "../types";
import { getStore } from "../db/store";
import { initDb } from "../db/init";
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

// 首次部署引导页（HTML）。初始化不会自动创建固定凭据，账号由部署者在本页表单里亲手设置。
function setupPage(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title} · EdgeOpenList</title>
<style>
  :root{--accent:#1890ff;--bg:#f5f6f8;--card:#fff;--text:#1f2329}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:var(--bg);color:var(--text);display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
  .card{background:var(--card);border-radius:18px;padding:34px 40px;max-width:460px;width:100%;box-shadow:0 10px 40px rgba(24,144,255,.12);text-align:center}
  h1{margin:0 0 14px;color:var(--accent);font-size:22px}
  p{margin:8px 0;line-height:1.7}
  .warn{color:#faad14;font-size:13px}
  a.btn,button.btn{display:inline-block;margin-top:18px;padding:11px 26px;background:var(--accent);color:#fff;border:none;border-radius:12px;text-decoration:none;font-weight:600;font-size:15px;cursor:pointer}
  a.btn:hover,button.btn:hover{opacity:.92}
  button.btn:disabled{opacity:.6;cursor:wait}
  code{background:#e6f4ff;padding:2px 6px;border-radius:6px;font-family:ui-monospace,monospace}
  .field{margin:12px 0;text-align:left}
  .field label{display:block;font-size:13px;color:#6b7280;margin-bottom:5px}
  .field input{width:100%;padding:10px 12px;border:1px solid #d5dae1;border-radius:10px;font-size:14px;background:#fff;color:var(--text)}
  .field input:focus{outline:none;border-color:var(--accent)}
  .err{color:#f5222d;font-size:13px;min-height:18px;margin:8px 0 0}
</style></head><body><div class="card"><h1>${title}</h1>${bodyHtml}</div></body></html>`;
}

function html(body: string, status = 200): Response {
  // no-store：初始化页必须永远实时 —— 代理/浏览器缓存旧版说明页会表现为「点了没反应」
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// 初始化表单页：部署者（或首个访问者）在这里直接设置管理员账号。
// 若部署时配置了 BOOTSTRAP_SECRET，表单会额外要求填写初始化密钥；未配置则无需密钥。
function setupForm(secretRequired: boolean): string {
  const secretField = secretRequired
    ? `<div class="field"><label for="su-secret">初始化密钥（BOOTSTRAP_SECRET）</label>
       <input id="su-secret" type="password" autocomplete="off" placeholder="部署时设置的初始化密钥" /></div>`
    : "";
  return setupPage(
    "初始化管理员",
    `<p>系统尚未创建管理员账号，请在下方设置。</p>
     <form id="su-form">
       <div class="field"><label for="su-user">用户名</label>
         <input id="su-user" autocomplete="username" placeholder="例如 admin" maxlength="64" /></div>
       <div class="field"><label for="su-pass">密码</label>
         <input id="su-pass" type="password" autocomplete="new-password" placeholder="至少 12 位" /></div>
       <div class="field"><label for="su-pass2">确认密码</label>
         <input id="su-pass2" type="password" autocomplete="new-password" placeholder="再输入一次" /></div>
       ${secretField}
       <p class="err" id="su-err" role="alert"></p>
       <button class="btn" type="submit" id="su-btn">完成初始化</button>
     </form>
     ${secretRequired ? "" : '<p class="warn">尚未配置初始化密钥：任何能访问本地址的人都可以完成初始化，请在部署后尽快设置。</p>'}
<script>
(function () {
  var form = document.getElementById("su-form");
  var btn = document.getElementById("su-btn");
  var err = document.getElementById("su-err");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    err.textContent = "";
    var username = document.getElementById("su-user").value.trim();
    var password = document.getElementById("su-pass").value;
    var pass2 = document.getElementById("su-pass2").value;
    var secretEl = document.getElementById("su-secret");
    if (!username) { err.textContent = "请输入用户名"; return; }
    if (password.length < 12) { err.textContent = "密码至少 12 位"; return; }
    if (password !== pass2) { err.textContent = "两次输入的密码不一致"; return; }
    btn.disabled = true;
    btn.textContent = "初始化中…";
    fetch("/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: username,
        password: password,
        bootstrapSecret: secretEl ? secretEl.value : ""
      })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; });
    }).then(function (res) {
      if (res.ok) {
        document.querySelector(".card").innerHTML =
          '<h1>初始化完成</h1><p>管理员账号已创建，现在可以登录使用了。</p>' +
          '<a class="btn" href="/">前往登录</a>';
      } else {
        err.textContent = (res.j && (res.j.message || res.j.error)) || "初始化失败，请重试";
        btn.disabled = false;
        btn.textContent = "完成初始化";
      }
    }).catch(function () {
      err.textContent = "网络错误，请重试";
      btn.disabled = false;
      btn.textContent = "完成初始化";
    });
  });
})();
</script>`
  );
}

export async function setupHandler(c: Context<AppEnv>) {
  if (!c.env.DB || typeof (c.env.DB as any).prepare !== "function") {
    return html(
      setupPage(
        "尚未绑定 D1",
        `<p>检测到本 Worker <b>未绑定 D1 数据库</b>，无法初始化管理员。</p>
         <p>请到 Cloudflare 控制台为 Worker 添加名为 <code>DB</code> 的 D1 数据库绑定，等待自动重新部署后再回来。</p>
         <a class="btn" href="/">返回首页</a>`
      )
    );
  }
  await ensureDbForSetup(c.env);
  const store = getStore(c.env);
  if (await store.countUsers() > 0) {
    return html(setupPage("已完成初始化", `<p>系统已存在管理员账号，请直接 <a href="/">登录</a>。</p>`));
  }
  return html(setupForm(Boolean(c.env.BOOTSTRAP_SECRET)));
}

// /setup 不走 /api/* 中间件，这里单独保证建表完成再读写用户表
async function ensureDbForSetup(env: Env): Promise<void> {
  try {
    await initDb(env);
  } catch {
    // 建表失败会在后续查询时暴露真实错误，这里不吞流程
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = aa.length ^ bb.length;
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (aa[i % Math.max(aa.length, 1)] ?? 0) ^ (bb[i % Math.max(bb.length, 1)] ?? 0);
  return diff === 0;
}

export async function setupPostHandler(c: Context<AppEnv>) {
  if (!c.env.DB || typeof (c.env.DB as any).prepare !== "function") throw badRequest("尚未绑定 D1 数据库");
  await ensureDbForSetup(c.env);
  const secret = c.env.BOOTSTRAP_SECRET || "";
  let body: { username?: string; password?: string; bootstrapSecret?: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
  const username = (body.username || "").trim();
  const password = body.password || "";
  // 配置了初始化密钥时强制校验；未配置时允许首个访问者直接初始化（仍受「零用户」限制）
  if (secret && !constantTimeEqual(body.bootstrapSecret || "", secret)) throw forbidden("初始化密钥错误");
  if (!username || username.length > 64 || password.length < 12 || password.length > 256) {
    throw badRequest("用户名不能为空，密码长度必须为 12 至 256 位");
  }
  const store = getStore(c.env);
  if (await store.countUsers() > 0) throw forbidden("系统已经完成初始化");
  try {
    await store.createUser(username, await hashPassword(password), "admin");
  } catch {
    if (await store.countUsers() > 0) throw forbidden("系统已经完成初始化");
    throw new Error("初始化管理员失败");
  }
  return c.json({ ok: true }, 201);
}

// GET /setup 展示表单页，POST /api/auth/setup 完成初始化（见 setupPostHandler）。

auth.post("/setup", setupPostHandler);

//

// 探测是否需要初始化（公开，供登录页判断是否显示「一键初始化」）
// secretRequired：部署时配置了 BOOTSTRAP_SECRET 则初始化表单需要额外填写密钥
export async function needsSetup(c: Context<AppEnv>) {
  if (!c.env.DB || typeof (c.env.DB as any).prepare !== "function") {
    return c.json({ needed: false, secretRequired: false, reason: "no-d1" });
  }
  const store = getStore(c.env);
  return c.json({ needed: (await store.countUsers()) === 0, secretRequired: Boolean(c.env.BOOTSTRAP_SECRET) });
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
