// KV 中的令牌存储：把 OAuth access/refresh token、网盘登录态等敏感凭据
// 存在 KV（而非 D1 的 config_json，避免明文落库），按挂载 ID 索引。
export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // 毫秒时间戳
  extra?: Record<string, any>;
}

function requireKv(kv: KVNamespace | undefined): KVNamespace {
  if (!kv || typeof (kv as any).get !== "function" || typeof (kv as any).put !== "function") {
    throw new Error("未配置 KV 绑定（KV），无法保存或读取登录令牌");
  }
  return kv;
}

export async function loadTokens(kv: KVNamespace | undefined, mountId: number): Promise<TokenSet | null> {
  const raw = await requireKv(kv).get(`tok:${mountId}`);
  return raw ? (JSON.parse(raw) as TokenSet) : null;
}

export async function saveTokens(kv: KVNamespace | undefined, mountId: number, t: TokenSet): Promise<void> {
  // 30 天过期，避免僵尸凭据长期驻留
  await requireKv(kv).put(`tok:${mountId}`, JSON.stringify(t), { expirationTtl: 60 * 60 * 24 * 30 });
}

export function isExpired(t: TokenSet | null, skewMs = 60_000): boolean {
  return !t || !t.access_token || t.expires_at - Date.now() < skewMs;
}
