import { Hono } from "hono";
import type { AppEnv } from "../types";
import { adminMiddleware } from "../middleware/auth";
import { getMount, updateMount } from "../db/schema";
import { saveTokens } from "../util/tokenstore";
import { buildAuthUrl, oauthExchange } from "../util/oauth";
import { OAUTH_PROVIDERS, OAUTH_PROVIDER_IDS, isOAuthDriver } from "../util/oauth-providers";

const oauth = new Hono<AppEnv>();

// 暴露支持的 OAuth provider 列表（前端据此显示"启动授权"按钮）—— 需管理员
oauth.get("/providers", adminMiddleware, (c) => c.json({ providers: OAUTH_PROVIDER_IDS }));

// 发起授权：返回平台登录页 URL（state=挂载ID），由前端在弹出窗口打开
oauth.get("/:provider/start", adminMiddleware, async (c) => {
  const provider = c.req.param("provider");
  const def = OAUTH_PROVIDERS[provider];
  if (!def) return c.json({ error: "未知 provider" }, 400);
  const mountId = c.req.query("mount");
  if (!mountId) return c.json({ error: "缺少 mount 参数" }, 400);
  const mount = await getMount(c.env.DB, Number(mountId));
  if (!mount) return c.json({ error: "挂载不存在" }, 404);
  const cfg = JSON.parse(mount.config_json || "{}");
  const redirectUri = cfg.redirectUri || `${new URL(c.req.url).origin}/api/oauth/${provider}/callback`;
  const url = buildAuthUrl(def.authorize, {
    client_id: cfg.clientId || "",
    response_type: "code",
    scope: def.scope,
    redirect_uri: redirectUri,
    state: String(mountId),
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
  const mount = await getMount(c.env.DB, Number(state));
  if (!mount) return c.text("挂载不存在", 404);
  const cfg = JSON.parse(mount.config_json || "{}");
  const redirectUri = cfg.redirectUri || `${new URL(c.req.url).origin}/api/oauth/${provider}/callback`;
  try {
    const t = await oauthExchange(def.token, cfg.clientId || "", cfg.clientSecret || "", redirectUri, code, def.extraToken || {});
    await saveTokens(c.env.KV, Number(state), t);
    const merged = { ...cfg, refreshToken: t.refresh_token || cfg.refreshToken };
    await updateMount(c.env.DB, Number(state), { config_json: JSON.stringify(merged) });
  } catch (e: any) {
    return c.text("授权失败：" + (e?.message || e), 500);
  }
  return c.text("授权成功，令牌已保存。可关闭此页面。");
});

// 供其它模块判断某驱动是否支持 OAuth
export { isOAuthDriver };
export default oauth;
