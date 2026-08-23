import { Hono } from "hono";
import type { AppEnv } from "../types";
import { adminMiddleware } from "../middleware/auth";
import { getStore } from "../db/store";
import { saveTokens } from "../util/tokenstore";
import { buildAuthUrl, oauthExchange } from "../util/oauth";
import { OAUTH_PROVIDERS, OAUTH_PROVIDER_IDS, isOAuthDriver } from "../util/oauth-providers";

const oauth = new Hono<AppEnv>();

// 暴露支持的 OAuth provider 列表（前端据此显示"启动授权"按钮）—— 需管理员
oauth.get("/providers", adminMiddleware, (c) => c.json({ providers: OAUTH_PROVIDER_IDS }));

function createState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// 发起授权：生成一次性 state 并绑定挂载与服务商，由前端在弹出窗口打开
oauth.get("/:provider/start", adminMiddleware, async (c) => {
  const provider = c.req.param("provider");
  const def = OAUTH_PROVIDERS[provider];
  if (!def) return c.json({ error: "未知 provider" }, 400);
  const mountId = c.req.query("mount");
  if (!mountId) return c.json({ error: "缺少 mount 参数" }, 400);
  const store = getStore(c.env);
  const mount = await store.getMount(Number(mountId));
  if (!mount) return c.json({ error: "挂载不存在" }, 404);
  const cfg = JSON.parse(mount.config_json || "{}");
  const redirectUri = cfg.redirectUri || `${new URL(c.req.url).origin}/api/oauth/${provider}/callback`;
  if (!c.env.KV || typeof (c.env.KV as any).put !== "function") return c.json({ error: "未配置 KV，无法发起授权" }, 503);
  const state = createState();
  await c.env.KV.put(`oauth:${state}`, JSON.stringify({ mountId: mount.id, provider, redirectUri }), { expirationTtl: 600 });
  const url = buildAuthUrl(def.authorize, {
    client_id: cfg.clientId || "",
    response_type: "code",
    scope: def.scope,
    redirect_uri: redirectUri,
    state,
    ...(def.extraAuth || {}),
  });
  return c.json({ url });
});

// 回调：平台重定向到此（浏览器导航，无 Bearer），用授权码换令牌并写入 KV。
// 公开端点（标准 OAuth 回调；state 绑定挂载，code 短时效，与 OpenList 行为一致）。
oauth.get("/:provider/callback", async (c) => {
  const provider = c.req.param("provider");
  const def = OAUTH_PROVIDERS[provider];
  if (!def) return c.text("未知 provider", 400);
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("缺少 code 或 state", 400);
  if (!c.env.KV || typeof (c.env.KV as any).get !== "function") return c.text("未配置 KV，无法完成授权", 503);
  const raw = await c.env.KV.get(`oauth:${state}`);
  await c.env.KV.delete(`oauth:${state}`);
  if (!raw) return c.text("授权已过期或 state 无效，请重新发起授权", 400);
  let pending: { mountId: number; provider: string; redirectUri: string };
  try { pending = JSON.parse(raw); } catch { return c.text("授权状态无效，请重新发起授权", 400); }
  if (pending.provider !== provider || !Number.isSafeInteger(pending.mountId)) return c.text("授权状态与服务商不匹配", 400);
  const store = getStore(c.env);
  const mount = await store.getMount(pending.mountId);
  if (!mount) return c.text("挂载不存在", 404);
  const cfg = JSON.parse(mount.config_json || "{}");
  try {
    const t = await oauthExchange(def.token, cfg.clientId || "", cfg.clientSecret || "", pending.redirectUri, code, def.extraToken || {});
    await saveTokens(c.env.KV, pending.mountId, t);
    await store.updateMount(pending.mountId, { config_json: JSON.stringify({ ...cfg, refreshToken: t.refresh_token || cfg.refreshToken }) });
  } catch (e: any) {
    return c.text("授权失败：" + (e?.message || e), 500);
  }
  return c.text("授权成功，令牌已保存。可关闭此页面。");
});

// 供其它模块判断某驱动是否支持 OAuth
export { isOAuthDriver };
export default oauth;
