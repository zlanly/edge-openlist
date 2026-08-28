// PikPak（OAuth/refresh_token + OSS 分片上传）。端点移植自 OpenList drivers/pikpak/*。
// 说明：上游上传返回的 S3Params 是阿里云 OSS（STS）凭证，此处用 WebCrypto HMAC-SHA1
// 实现 OSS V1 签名做流式 PUT（单 PUT 支持任意大小）。上游校验用的是 GCID 自定义哈希，
// WebCrypto 无法直接得到，这里用 SHA1 兜底（已在注释标注，可能触发服务端校验告警，属已知限制）。
// captcha_sign 需要 MD5，WebCrypto 无 MD5，故内联纯 JS MD5。
import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import {
  getPikPakClient,
  isPikPakCaptchaCode,
  isPikPakRetryableAuthCode,
  md5,
  parsePikPakResponse,
  pikpakAccountMeta,
  pikpakClientHeaders,
  pikpakOssEndpoint,
  pikpakRootId,
} from "./pikpak-common";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";

const API_DRIVE = "https://api-drive.mypikpak.net/drive/v1";
const API_USER = "https://user.mypikpak.net/v1";
export class PikPakDriver extends CloudBase {
  readonly id = "pikpak";
  private accessToken = "";
  private refreshTok = "";
  private captchaToken = "";
  private deviceId = "";
  private userId = "";
  private rootId = "";
  private readonly idCache = new Map<string, string>();
  private readonly itemCache = new Map<string, FileItem>();

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  private get platform(): string {
    return this.cfgStr("platform") || "web";
  }
  private get client() {
    return getPikPakClient(this.platform, this.deviceId, this.userId);
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.deviceId = this.cfgStr("device_id") || md5(this.cfgStr("username") + this.cfgStr("password"));
    this.rootId = pikpakRootId(this.cfg as Record<string, unknown>);
    this.idCache.clear();
    this.itemCache.clear();
    this.idCache.set("/", this.rootId);
    this.captchaToken = this.cfgStr("captcha_token") || "";
    const stored = await loadTokens(this.env.KV, this.mountId).catch(() => null);
    const configuredRefreshToken = this.cfgStr("refresh_token");
    const hasPasswordLogin = Boolean(this.cfgStr("username") && this.cfgStr("password"));
    // 配置了账号密码时优先走登录，不要被 KV 中遗留的旧 refresh_token 劫持。
    // 否则用户明明选择了账号密码，挂载仍会拿历史令牌刷新并卡在 permission_denied。
    this.refreshTok = configuredRefreshToken || (!hasPasswordLogin ? stored?.refresh_token || "" : "");
    try {
      if (this.refreshTok) await this.refreshToken();
      else await this.login();
    } catch (e: any) {
      // 令牌过期时，若仍有账号密码，按官方驱动回退到重新登录。
      if (
        this.cfgStr("username") &&
        this.cfgStr("password") &&
        /失效|invalid|permission_denied|invalid_grant|unauthorized|4126/i.test(String(e?.message || e))
      ) {
        // 旧 refresh_token 可能已被服务端撤销（permission_denied），但账号密码仍可用时
        // 按 OpenListNext 的行为回退登录，避免「下载曾经正常、重启后上传初始化失败」。
        await this.login();
      } else {
        throw e;
      }
    }
    try {
      await this.refreshCaptchaToken("GET:/drive/v1/files");
    } catch {
      // 需要人工验证时保留已填写的 token，让后续请求返回可操作的上游错误。
    }
  }

  private async login(): Promise<void> {
    const username = this.cfgStr("username");
    const password = this.cfgStr("password");
    if (!username || !password) throw new Error("pikpak 需要 refresh_token，或同时填写 username 和 password");
    if (!this.captchaToken) await this.refreshCaptchaToken("POST:/v1/auth/signin", username);
    const r = await fetch(`${API_USER}/auth/signin?client_id=${encodeURIComponent(this.client.id)}`, {
      method: "POST",
      headers: {
        ...pikpakClientHeaders(this.client, this.deviceId, this.captchaToken),
        Accept: "application/json",
      },
      body: JSON.stringify({
        captcha_token: this.captchaToken,
        client_id: this.client.id,
        client_secret: this.client.secret,
        ...pikpakAccountMeta(username),
        password,
      }),
    });
    const j = await parsePikPakResponse<any>(r, "登录", true);
    if (j.error_code) throw new Error(`pikpak 登录失败: ${j.error || j.error_description}`);
    this.accessToken = j.access_token || "";
    this.refreshTok = j.refresh_token || "";
    this.userId = j.sub || this.userId;
    if (!this.refreshTok) throw new Error("pikpak 登录未返回 refresh_token");
    await saveTokens(this.env.KV, this.mountId, {
      access_token: this.accessToken,
      refresh_token: this.refreshTok,
      expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
      extra: j,
    });
  }

  private async refreshToken(): Promise<void> {
    const body = {
      client_id: this.client.id,
      client_secret: this.client.secret,
      grant_type: "refresh_token",
      refresh_token: this.refreshTok,
    };
    const r = await fetch(`${API_USER}/auth/token?client_id=${this.client.id}`, {
      method: "POST",
      headers: pikpakClientHeaders(this.client, this.deviceId, this.captchaToken),
      body: JSON.stringify(body),
    });
    const j = await parsePikPakResponse<any>(r, "刷新令牌", true);
    if (j.error_code) {
      if (j.error_code === 4126) throw new Error("pikpak refresh_token 失效，请重新获取");
      throw new Error(`pikpak 令牌刷新失败: ${j.error || j.error_description}`);
    }
    this.accessToken = j.access_token || "";
    this.refreshTok = j.refresh_token || this.refreshTok;
    this.userId = j.sub || this.userId;
    await saveTokens(this.env.KV, this.mountId, {
      access_token: this.accessToken,
      refresh_token: this.refreshTok,
      expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
      extra: j,
    });
  }

  private async getCaptchaSign(): Promise<[string, string]> {
    const ts = String(Date.now());
    let str = this.client.id + this.client.version + this.client.pkg + this.deviceId + ts;
    for (const algo of this.client.algorithms) str = md5(str + algo);
    return [ts, "1." + str];
  }

  private async refreshCaptchaToken(action: string, userIdForCaptcha = ""): Promise<void> {
    const [ts, sign] = await this.getCaptchaSign();
    const body = {
      action,
      captcha_token: this.captchaToken,
      client_id: this.client.id,
      device_id: this.deviceId,
      meta: { client_version: this.client.version, package_name: this.client.pkg, user_id: this.userId, username: action.includes("signin") ? userIdForCaptcha : undefined, timestamp: ts, captcha_sign: sign },
      redirect_uri: "xlaccsdk01://xbase.cloud/callback?state=harbor",
    };
    const r = await fetch(`${API_USER}/shield/captcha/init`, {
      method: "POST",
      headers: pikpakClientHeaders(this.client, this.deviceId, this.captchaToken),
      body: JSON.stringify(body),
    });
    const j = await parsePikPakResponse<any>(r, "验证码", true);
    if (j.error_code) throw new Error(`pikpak captcha: ${j.error || j.error_description}`);
    if (j.url) throw new Error(`pikpak 需要人机验证: ${j.url}`);
    this.captchaToken = j.captcha_token;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      "User-Agent": this.client.userAgent,
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
      headers: { ...(await this.hdrs()), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await parsePikPakResponse<any>(r, `${method} ${u.pathname}`, true);
    if (j.error_code) {
      if (retry && isPikPakRetryableAuthCode(j.error_code)) {
        await this.refreshToken();
        return this.request<T>(url, method, body, query, false);
      }
      if (retry && isPikPakCaptchaCode(j.error_code)) {
        await this.refreshCaptchaToken(method + ":" + new URL(url).pathname);
        return this.request<T>(url, method, body, query, false);
      }
      throw new Error(`pikpak: ${j.error || j.error_description}`);
    }
    return j as T;
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.getIdByPath(path);
    const out: FileItem[] = [];
    let page = "first";
    for (;;) {
      if (page === "first") page = "";
      const query: Record<string, string> = {
        thumbnail_size: "SIZE_LARGE",
        with_audit: "true",
        limit: "100",
        filters: `{"phase":{"eq":"PHASE_TYPE_COMPLETE"},"trashed":{"eq":false}}`,
        page_token: page,
      };
      // 个人盘根目录由空 parent_id 表示；发送字面量 "root" 会被真实 API 判为 invalid_argument。
      // 保留空字段本身，和官方接口请求格式一致。
      query.parent_id = id;
      const j = await this.request<any>(`${API_DRIVE}/files`, "GET", undefined, query);
      for (const f of j.files || []) {
        const itemPath = joinPath(path, f.name);
        const item: FileItem = {
          name: f.name,
          path: itemPath,
          is_dir: f.kind === "drive#folder",
          size: Number(f.size || 0),
          modified: f.modified_time ? Date.parse(f.modified_time) : 0,
          etag: f.id,
        };
        if (f.id) this.idCache.set(normalizePath(itemPath), f.id);
        this.itemCache.set(normalizePath(itemPath), item);
        out.push(item);
      }
      page = j.next_page_token || "";
      if (!page) break;
    }
    return out;
  }

  private async getIdByPath(path: string): Promise<string> {
    const normalized = normalizePath(path);
    if (this.idCache.has(normalized)) return this.idCache.get(normalized) || "";
    const parent = parentPath(normalized);
    const items = await this.list(parent);
    const it = items.find((i) => normalizePath(i.path) === normalized);
    if (!it?.etag) throw new Error("not found: " + normalized);
    this.idCache.set(normalized, it.etag);
    return it.etag;
  }

  async get(path: string): Promise<FileItem> {
    const normalized = normalizePath(path);
    const cached = this.itemCache.get(normalized);
    if (cached) return cached;
    const items = await this.list(parentPath(normalized));
    const it = items.find((i) => normalizePath(i.path) === normalized);
    if (!it) throw new Error("not found: " + normalized);
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
    await ossPutStream(
      pikpakOssEndpoint(p.endpoint, p.bucket, this.platform),
      p.bucket,
      p.key,
      p.access_key_id,
      p.access_key_secret,
      p.security_token,
      buf,
      buf.length,
    );
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
async function ossPutStream(endpoint: string, bucket: string, key: string, _ak: string, _sk: string, token: string, body: Uint8Array | ReadableStream, size: number): Promise<void> {
  // PikPak 返回的是临时 OSS 上传参数。参考 OpenListNext 的已有驱动，
  // 这里只发送长度和 STS token，不再自行拼 OSS V1 Authorization：
  // endpoint/STS 参数已经由 PikPak 生成，额外签名会导致 OSS 返回 403。
  const normalizedEndpoint = endpoint.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  // 部分账号返回的 endpoint 已带 bucket 前缀；避免重复拼接成
  // bucket.bucket.endpoint（该地址会被 Cloudflare 返回 530/1016）。
  const host = normalizedEndpoint.startsWith(`${bucket}.`)
    ? normalizedEndpoint
    : `${bucket}.${normalizedEndpoint}`;
  const url = `https://${host}/${key}`;
  const headers: Record<string, string> = {
    "Content-Length": String(size),
    "x-oss-security-token": token,
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
