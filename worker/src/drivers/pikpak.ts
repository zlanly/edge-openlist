// PikPak（OAuth/refresh_token + OSS 分片上传）。端点移植自 OpenList drivers/pikpak/*。
// 说明：上游上传返回的 S3Params 是阿里云 OSS（STS）凭证，此处用 WebCrypto HMAC-SHA1
// 实现 OSS V1 签名做流式 PUT（单 PUT 支持任意大小）。上游校验用的是 GCID 自定义哈希，
// WebCrypto 无法直接得到，这里用 SHA1 兜底（已在注释标注，可能触发服务端校验告警，属已知限制）。
// captcha_sign 需要 MD5，WebCrypto 无 MD5，故内联纯 JS MD5。
import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";

const API_DRIVE = "https://api-drive.mypikpak.net/drive/v1";
const API_USER = "https://user.mypikpak.net/v1";
const WEB = { id: "YUMx5nI8ZU8Ap8pm", secret: "dbw2OtmVEeuUvIptb1Coyg", version: "2.0.0", pkg: "mypikpak.com" };
const WEB_ALGOS = [
  "C9qPpZLN8ucRTaTiUMWYS9cQvWOE", "+r6CQVxjzJV6LCV", "F", "pFJRC",
  "9WXYIDGrwTCz2OiVlgZa90qpECPD6olt", "/750aCr4lm/Sly/c", "RB+DT/gZCrbV", "",
  "CyLsf7hdkIRxRm215hl", "7xHvLi2tOYP0Y92b", "ZGTXXxu8E/MIWaEDB+Sm/", "1UI3",
  "E7fP5Pfijd+7K+t6Tg/NhuLq0eEUVChpJSkrKxpO", "ihtqpG6FMt65+Xk+tWUH2", "NhXXU9rg4XXdzo7u5o",
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36";

// ---- 纯 JS MD5（WebCrypto 无 MD5，用于 captcha_sign / deviceId）----
// 标准实现（RFC 1321），仅用于 PikPak 短字符串（deviceId / captcha_sign），
// 输入长度远小于 2^29 字节，bitLen 低/高位拆分安全。
function md5(s: string): string {
  const rotl = (n: number, c: number): number => (n << c) | (n >>> (32 - c));
  const msg = new TextEncoder().encode(s);
  const len = msg.length;
  const bitLen = len * 8;
  const total = (len + 1 + 8 + 63) & ~63; // +0x80 分隔 + 8 字节长度 + 补齐到 64
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, bitLen >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bitLen / 4294967296), true);
  const K = new Array<number>(64);
  for (let i = 0; i < 64; i++) K[i] = (Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  const S = [
    [7, 12, 17, 22],
    [5, 9, 14, 20],
    [4, 11, 16, 23],
    [6, 10, 15, 21],
  ];
  let [a0, b0, c0, d0] = [0x67452301, -0x10325477 | 0, -0x67452302 | 0, 0x10325476];
  const x = new Int32Array(16);
  for (let i = 0; i < total; i += 64) {
    for (let j = 0; j < 16; j++) x[j] = dv.getInt32(i + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let j = 0; j < 64; j++) {
      let f: number, g: number, s: number;
      if (j < 16) { f = (B & C) | (~B & D); g = j; s = S[0][j % 4]; }
      else if (j < 32) { f = (B & D) | (C & ~D); g = (5 * j + 1) % 16; s = S[1][j % 4]; }
      else if (j < 48) { f = B ^ C ^ D; g = (3 * j + 5) % 16; s = S[2][j % 4]; }
      else { f = C ^ (B | ~D); g = (7 * j) % 16; s = S[3][j % 4]; }
      f = (f + A + K[j] + x[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(f, s)) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, "0");
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

export class PikPakDriver extends CloudBase {
  readonly id = "pikpak";
  private accessToken = "";
  private refreshTok = "";
  private captchaToken = "";
  private deviceId = "";
  private userId = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  private get platform(): string {
    return this.cfgStr("platform") || "web";
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.deviceId = this.cfgStr("device_id") || md5(this.cfgStr("username") + this.cfgStr("password"));
    this.captchaToken = this.cfgStr("captcha_token") || "";
    this.refreshTok = this.cfgStr("refresh_token") || "";
    if (!this.refreshTok) throw new Error("pikpak 需要 refresh_token（无 captcha 登录不支持自动）");
    await this.refreshToken();
    // 拉取一次 captcha token（若缺失则尝试，失败仅告警）
    try {
      await this.refreshCaptchaToken("GET:/drive/v1/files");
    } catch (e) {
      // captcha 需要人工验证时忽略，后续请求可能受限
    }
  }

  private async refreshToken(): Promise<void> {
    const body = {
      client_id: WEB.id,
      client_secret: WEB.secret,
      grant_type: "refresh_token",
      refresh_token: this.refreshTok,
    };
    const r = await fetch(`${API_USER}/auth/token?client_id=${WEB.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await r.json()) as any;
    if (j.error_code) {
      if (j.error_code === 4126 && this.cfgStr("username")) {
        throw new Error("pikpak refresh_token 失效，请重新获取");
      }
      throw new Error(`pikpak 令牌刷新失败: ${j.error || j.error_description}`);
    }
    this.accessToken = j.access_token;
    this.refreshTok = j.refresh_token || this.refreshTok;
    this.userId = j.sub || this.userId;
    await saveTokens(this.env.KV, this.mountId, {
      access_token: this.accessToken,
      refresh_token: this.refreshTok,
      expires_at: Date.now() + 3600 * 1000,
      extra: j,
    });
  }

  private async getCaptchaSign(): Promise<[string, string]> {
    const ts = String(Date.now());
    let str = WEB.id + WEB.version + WEB.pkg + this.deviceId + ts;
    for (const algo of WEB_ALGOS) str = md5(str + algo);
    return [ts, "1." + str];
  }

  private async refreshCaptchaToken(action: string): Promise<void> {
    const [ts, sign] = await this.getCaptchaSign();
    const body = {
      action,
      captcha_token: this.captchaToken,
      client_id: WEB.id,
      device_id: this.deviceId,
      meta: { client_version: WEB.version, package_name: WEB.pkg, user_id: this.userId, timestamp: ts, captcha_sign: sign },
      redirect_uri: "xlaccsdk01://xbase.cloud/callback?state=harbor",
    };
    const r = await fetch(`${API_USER}/shield/captcha/init?client_id=${WEB.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await r.json()) as any;
    if (j.error_code) throw new Error(`pikpak captcha: ${j.error || j.error_description}`);
    if (j.url) throw new Error(`pikpak 需要人机验证: ${j.url}`);
    this.captchaToken = j.captcha_token;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      "User-Agent": UA,
      "X-Device-ID": this.deviceId,
      "X-Captcha-Token": this.captchaToken,
    };
    if (this.accessToken) h["Authorization"] = "Bearer " + this.accessToken;
    return h;
  }

  private async request<T>(url: string, method: string, body?: any, query?: Record<string, string>, retry = true): Promise<T> {
    const u = new URL(url);
    if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    const r = await fetch(u.toString(), {
      method,
      headers: await this.hdrs(),
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = (await r.json().catch(() => ({}))) as any;
    if (j.error_code) {
      if (retry && [4122, 4121, 16].includes(j.error_code)) {
        await this.refreshToken();
        return this.request<T>(url, method, body, query, false);
      }
      if (retry && j.error_code === 9) {
        await this.refreshCaptchaToken(method + ":" + new URL(url).pathname);
        return this.request<T>(url, method, body, query, false);
      }
      throw new Error(`pikpak: ${j.error || j.error_description}`);
    }
    return j as T;
  }

  async list(path: string): Promise<FileItem[]> {
    const id = path === "/" ? "root" : (await this.getIdByPath(path));
    const out: FileItem[] = [];
    let page = "first";
    for (;;) {
      if (page === "first") page = "";
      const j = await this.request<any>(`${API_DRIVE}/files`, "GET", undefined, {
        parent_id: id,
        thumbnail_size: "SIZE_LARGE",
        with_audit: "true",
        limit: "100",
        filters: `{"phase":{"eq":"PHASE_TYPE_COMPLETE"},"trashed":{"eq":false}}`,
        page_token: page,
      });
      for (const f of j.files || []) {
        out.push({
          name: f.name,
          path: joinPath(path, f.name),
          is_dir: f.kind === "drive#folder",
          size: Number(f.size || 0),
          modified: f.modified_time ? Date.parse(f.modified_time) : 0,
          etag: f.id,
        });
      }
      page = j.next_page_token || "";
      if (!page) break;
    }
    return out;
  }

  private async getIdByPath(path: string): Promise<string> {
    if (path === "/") return "root";
    const parent = parentPath(path);
    const items = await this.list(parent);
    const it = items.find((i) => i.path === path);
    if (!it) throw new Error("not found: " + path);
    return it.etag || "";
  }

  async get(path: string): Promise<FileItem> {
    const items = await this.list(parentPath(path));
    const it = items.find((i) => i.path === path);
    if (!it) throw new Error("not found: " + path);
    return it;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const id = await this.getIdByPath(path);
    const q: Record<string, string> = { _magic: "2021", usage: "FETCH", thumbnail_size: "SIZE_LARGE" };
    if (this.cfgStr("disable_media_link") !== "true") q["usage"] = "CACHE";
    const resp = await this.request<any>(`${API_DRIVE}/files/${id}`, "GET", undefined, q);
    let url = resp.web_content_link;
    if (this.cfgStr("disable_media_link") !== "true" && resp.medias?.length && resp.medias[0]?.link?.url) {
      url = resp.medias[0].link.url;
    }
    if (!url) throw new Error("pikpak 无法获取下载链接");
    const h: Record<string, string> = {};
    if (range) h["Range"] = range;
    return fetch(url, { headers: h });
  }

  // 创建上传任务，返回 Worker 代理会话；putContent 负责流式直传 OSS
  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "pikpak" } };
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    // 读取整段以计算哈希（上游要求文件哈希；此处缓冲一次，
    // 与 mediafire 同理——属已知限制，避免流式哈希在 WebCrypto 不可得）。
    const buf = await readAll(body);
    const sha1 = await sha1Hex(buf);
    const parentId = await this.getIdByPath(parentPath(path));
    const task = await this.request<any>(`${API_DRIVE}/files`, "POST", {
      kind: "drive#file",
      name: basename(path),
      size: buf.length,
      hash: sha1.toUpperCase(),
      upload_type: "UPLOAD_TYPE_RESUMABLE",
      objProvider: { provider: "UPLOAD_TYPE_UNKNOWN" },
      parent_id: parentId,
      folder_type: "NORMAL",
    });
    if (!task.resumable) return; // 秒传命中
    const p = task.resumable.params;
    await ossPutStream(p.endpoint, p.bucket, p.key, p.access_key_id, p.access_key_secret, p.security_token, buf, buf.length);
  }

  async mkdir(path: string): Promise<void> {
    const parentId = await this.getIdByPath(parentPath(path));
    await this.request(`${API_DRIVE}/files`, "POST", {
      kind: "drive#folder",
      parent_id: parentId,
      name: basename(path),
    });
  }

  async remove(path: string): Promise<void> {
    const id = await this.getIdByPath(path);
    await this.request(`${API_DRIVE}/files:batchTrash`, "POST", { ids: [id] });
  }

  async rename(from: string, to: string): Promise<void> {
    const id = await this.getIdByPath(from);
    await this.request(`${API_DRIVE}/files/${id}`, "PATCH", { name: basename(to) });
  }

  async move(from: string, to: string): Promise<void> {
    const id = await this.getIdByPath(from);
    const dstId = await this.getIdByPath(parentPath(to));
    await this.request(`${API_DRIVE}/files:batchMove`, "POST", { ids: [id], to: { parent_id: dstId } });
  }
}

// ---- OSS 流式直传（WebCrypto HMAC-SHA1 签名）----
async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const ck = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: { name: "SHA-1" } }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", ck, enc.encode(data));
  let bin = "";
  const b = new Uint8Array(sig);
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin);
}

async function ossSign(method: string, contentType: string, date: string, token: string, bucket: string, key: string, secret: string, accessKey: string): Promise<string> {
  const canonHeaders = token ? `x-oss-security-token:${token}\n` : "";
  const resource = `/${bucket}/${key}`;
  const stringToSign = `${method}\n\n${contentType}\n${date}\n${canonHeaders}${resource}`;
  const sig = await hmacSha1Base64(secret, stringToSign);
  return `OSS ${accessKey}:${sig}`;
}

async function ossPutStream(endpoint: string, bucket: string, key: string, ak: string, sk: string, token: string, body: Uint8Array | ReadableStream, size: number): Promise<void> {
  const url = `https://${bucket}.${endpoint}/${key}`;
  const date = new Date().toUTCString();
  const auth = await ossSign("PUT", "application/octet-stream", date, token, bucket, key, sk, ak);
  const headers: Record<string, string> = {
    Authorization: auth,
    "Content-Type": "application/octet-stream",
    "Content-Length": String(size),
    Date: date,
    "x-oss-security-token": token,
    "User-Agent": "aliyun-sdk-android/2.9.13(Linux/Android 14/M2004j7ac;UKQ1.231108.001)",
  };
  const r = await fetch(url, { method: "PUT", headers, body });
  if (!r.ok) throw new Error(`pikpak OSS 上传失败 ${r.status}: ${await r.text().catch(() => "")}`);
}

async function readAll(stream: ReadableStream): Promise<Uint8Array> {
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) { chunks.push(value); total += value.length; }
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  return all;
}

async function sha1Hex(buf: Uint8Array): Promise<string> {
  const out = await crypto.subtle.digest({ name: "SHA-1" }, buf);
  return [...new Uint8Array(out)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type _Avoid = Env | DriverConfig;
