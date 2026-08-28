export type PikPakPlatform = "android" | "web" | "pc";

export interface PikPakClient {
  id: string;
  secret: string;
  version: string;
  pkg: string;
  sdk: string;
  algorithms: readonly string[];
  userAgent: string;
}

/** 先读取原文再解析，避免上游返回 HTML 时被误判为空成功。 */
export async function parsePikPakResponse<T>(response: Response, action: string, allowStructuredError = false): Promise<T> {
  const text = await response.text();
  let value: any;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`pikpak ${action} 返回非 JSON（HTTP ${response.status}）：${text.slice(0, 240)}`);
  }
  // 保留带 error_code 的 JSON 错误给上层处理（例如验证码失效后刷新令牌并重试）。
  // 没有结构化错误信息的非 2xx 响应不能被当成成功结果。
  if (!response.ok && !allowStructuredError) {
    const detail = value?.error || value?.error_description || value?.message || text.slice(0, 240) || "空响应";
    throw new Error(`pikpak ${action} HTTP ${response.status}：${detail}`);
  }
  return value as T;
}

export function pikpakClientHeaders(client: PikPakClient, deviceId: string, captchaToken = ""): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": client.userAgent,
    "X-Client-ID": client.id,
    "X-Device-ID": deviceId,
  };
  if (captchaToken) headers["X-Captcha-Token"] = captchaToken;
  return headers;
}

export function pikpakAccountMeta(username: string): Record<string, string> {
  const value = username.trim();
  if (!value) return {};
  if (/^[^@\s]+@[^@\s]+$/.test(value)) return { email: value, username: value };
  if (/^\+?[0-9][0-9\s-]{5,}$/.test(value)) return { phone_number: value, username: value };
  return { username: value };
}

export function pikpakOssEndpoint(endpoint: string, _bucket: string, platform: string): string {
  // 沿用 OpenListNext：Android 客户端固定把 OSS 上传落到 mypikpak.net；
  // 其他平台必须原样使用接口返回的 endpoint，再由调用方拼接 bucket。
  if (platform === "android") return "mypikpak.net";
  return endpoint.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function pikpakRootId(config: Record<string, unknown>): string {
  // PikPak API 用空 parent_id 表示账号根目录；"root" 不是通用的真实目录 ID，
  // 直接传它会在真实账号上返回 invalid_argument。
  return String(config.root_folder_id || "").trim();
}

export function isPikPakRetryableAuthCode(code: unknown): boolean {
  // 10 是 access token 失效，和 4121/4122/16 一样应刷新令牌后重试。
  return [10, 4121, 4122, 16].includes(Number(code));
}

export function isPikPakCaptchaCode(code: unknown): boolean {
  return Number(code) === 9;
}

const ANDROID_ALGORITHMS = [
  "SOP04dGzk0TNO7t7t9ekDbAmx+eq0OI1ovEx",
  "nVBjhYiND4hZ2NCGyV5beamIr7k6ifAsAbl",
  "Ddjpt5B/Cit6EDq2a6cXgxY9lkEIOw4yC1GDF28KrA",
  "VVCogcmSNIVvgV6U+AochorydiSymi68YVNGiz",
  "u5ujk5sM62gpJOsB/1Gu/zsfgfZO",
  "dXYIiBOAHZgzSruaQ2Nhrqc2im",
  "z5jUTBSIpBN9g4qSJGlidNAutX6",
  "KJE2oveZ34du/g1tiimm",
];

const WEB_ALGORITHMS = [
  "C9qPpZLN8ucRTaTiUMWYS9cQvWOE", "+r6CQVxjzJV6LCV", "F", "pFJRC",
  "9WXYIDGrwTCz2OiVlgZa90qpECPD6olt", "/750aCr4lm/Sly/c", "RB+DT/gZCrbV", "",
  "CyLsf7hdkIRxRm215hl", "7xHvLi2tOYP0Y92b", "ZGTXXxu8E/MIWaEDB+Sm/", "1UI3",
  "E7fP5Pfijd+7K+t6Tg/NhuLq0eEUVChpJSkrKxpO", "ihtqpG6FMt65+Xk+tWUH2", "NhXXU9rg4XXdzo7u5o",
];

const PC_ALGORITHMS = [
  "KHBJ07an7ROXDoK7Db", "G6n399rSWkl7WcQmw5rpQInurc1DkLmLJqE",
  "JZD1A3M4x+jBFN62hkr7VDhkkZxb9g3rWqRZqFAAb", "fQnw/AmSlbbI91Ik15gpddGgyU7U",
  "/Dv9JdPYSj3sHiWjouR95NTQff", "yGx2zuTjbWENZqecNI+edrQgqmZKP",
  "ljrbSzdHLwbqcRn", "lSHAsqCkGDGxQqqwrVu", "TsWXI81fD1", "vk7hBjawK/rOSrSWajtbMk95nfgf3",
];

const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36";
const PC_UA =
  "MainWindow Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) PikPak/2.6.11.4955 Chrome/100.0.4896.160 Electron/18.3.15 Safari/537.36";

export function getPikPakClient(platform: string, deviceId = "", userId = ""): PikPakClient {
  if (platform === "android") {
    return {
      id: "YNxT9w7GMdWvEOKa",
      secret: "dbw2OtmVEeuUvIptb1Coyg",
      version: "1.53.2",
      pkg: "com.pikcloud.pikpak",
      sdk: "2.0.6.206003",
      algorithms: ANDROID_ALGORITHMS,
      userAgent: androidUserAgent(deviceId, userId),
    };
  }
  if (platform === "pc") {
    return {
      id: "YvtoWO6GNHiuCl7x",
      secret: "1NIH5R1IEe2pAxZE3hv3uA",
      version: "undefined",
      pkg: "mypikpak.com",
      sdk: "8.0.3",
      algorithms: PC_ALGORITHMS,
      userAgent: PC_UA,
    };
  }
  return {
    id: "YUMx5nI8ZU8Ap8pm",
    secret: "dbw2OtmVEeuUvIptb1Coyg",
    version: "2.0.0",
    pkg: "mypikpak.com",
    sdk: "8.0.3",
    algorithms: WEB_ALGORITHMS,
    userAgent: WEB_UA,
  };
}

function androidUserAgent(deviceId: string, userId: string): string {
  const deviceSign = `div101.${deviceId}${md5(`${deviceId}com.pikcloud.pikpak1appkey`)}`;
  return [
    "ANDROID-com.pikcloud.pikpak/1.53.2 protocolVersion/200 accesstype/",
    "clientid/YNxT9w7GMdWvEOKa clientversion/1.53.2 action_type/ networktype/WIFI",
    `deviceid/${deviceId} providername/NONE devicesign/${deviceSign} refresh_token/`,
    "sdkversion/2.0.6.206003 appname/android-com.pikcloud.pikpak",
    `usrno/${userId} devicename/Xiaomi_M2004j7ac osversion/13 platformversion/10`,
  ].join(" ");
}

// WebCrypto 不提供 MD5；PikPak 要求 RFC 1321 的小端 digest 文本。
export function md5(input: string): string {
  const rotate = (n: number, bits: number) => (n << bits) | (n >>> (32 - bits));
  const message = new TextEncoder().encode(input);
  const bitLength = message.length * 8;
  const total = (message.length + 9 + 63) & ~63;
  const buffer = new Uint8Array(total);
  buffer.set(message);
  buffer[message.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(total - 8, bitLength >>> 0, true);
  view.setUint32(total - 4, Math.floor(bitLength / 0x100000000), true);
  const k = Array.from({ length: 64 }, (_, i) => (Math.abs(Math.sin(i + 1)) * 0x100000000) | 0);
  const shifts = [
    [7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21],
  ];
  let a0 = 0x67452301 | 0;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;
  const words = new Int32Array(16);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getInt32(offset + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number, round: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; round = 0; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; round = 1; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; round = 2; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; round = 3; }
      const sum = (f + a + k[i] + words[g]) | 0;
      a = d; d = c; c = b;
      b = (b + rotate(sum, shifts[round][i % 4])) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const word = (n: number) => {
    const u = n >>> 0;
    return [u & 255, (u >>> 8) & 255, (u >>> 16) & 255, u >>> 24]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  return word(a0) + word(b0) + word(c0) + word(d0);
}
