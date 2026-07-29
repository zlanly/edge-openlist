// KV 中的令牌存储：把 OAuth access/refresh token、网盘登录态等敏感凭据
// 存在 KV（而非 D1 的 config_json，避免明文落库），按挂载 ID 索引。
export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // 毫秒时间戳
  extra?: Record<string, any>;
}

export async function loadTokens(kv: KVNamespace, mountId: number): Promise<TokenSet | null> {
  const raw = await kv.get(`tok:${mountId}`);
  return raw ? (JSON.parse(raw) as TokenSet) : null;
}

export async function saveTokens(kv: KVNamespace, mountId: number, t: TokenSet): Promise<void> {
  // 30 天过期，避免僵尸凭据长期驻留
  await kv.put(`tok:${mountId}`, JSON.stringify(t), { expirationTtl: 60 * 60 * 24 * 30 });
}

export function isExpired(t: TokenSet | null, skewMs = 60_000): boolean {
  return !t || !t.access_token || t.expires_at - Date.now() < skewMs;
}
