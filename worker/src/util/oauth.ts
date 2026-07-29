import type { TokenSet } from "./tokenstore";

// OAuth2 授权码换取令牌（授权端点拼接）
export function buildAuthUrl(
  authorizeEndpoint: string,
  params: Record<string, string>
): string {
  return `${authorizeEndpoint}?${new URLSearchParams(params).toString()}`;
}

// 用 refresh_token 换发 access_token（OAuth2 RFC6749）
export async function oauthRefresh(
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`令牌刷新失败 ${r.status}: ${await r.text().catch(() => "")}`);
  const j = (await r.json()) as Record<string, any>;
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token || refreshToken,
    expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
    extra: j,
  };
}

// 用授权码换令牌（回调阶段）
export async function oauthExchange(
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string,
  extra: Record<string, string> = {}
): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    ...extra,
  });
  const r = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`授权码换令牌失败 ${r.status}`);
  const j = (await r.json()) as Record<string, any>;
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
    extra: j,
  };
}
