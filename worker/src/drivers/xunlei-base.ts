import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";
import { md5Hex, sha1Hex } from "../util/md5";

const API_URL = "https://api-pan.xunlei.com/drive/v1";
const FILE_API = API_URL + "/files";
const TASK_API = API_URL + "/tasks";
const XLUSER = "https://xluser-ssl.xunlei.com/v1";
const APPID = "40";
const APPKEY = "34a062aaa22f906fca4fefe9fb3a3021";

// 迅雷系（thunder/thunder_browser/thunderx）共享逻辑：captcha 签名 + refresh_token + S3 分片直传。
export abstract class XunLeiBase extends CloudBase {
  readonly id: string = "xunlei";
  protected clientID = "";
  protected clientSecret = "";
  protected clientVersion = "";
  protected packageName = "";
  protected deviceID = "";
  protected userAgent = "";
  protected downloadUserAgent = "";
  protected algorithms: string[] = [];
  protected space = "";
  protected useVideoUrl = false;

  private accessToken = "";
  private refreshToken = "";
  private captchaToken = "";
  private userID = "";
  private expiresAt = 0;

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.clientID = this.cfgStr("client_id");
    this.clientSecret = this.cfgStr("client_secret");
    this.clientVersion = this.cfgStr("client_version") || "8.31.0.9726";
    this.packageName = this.cfgStr("package_name") || "com.xunlei.downloadprovider";
    this.deviceID = this.cfgStr("device_id") || md5Hex(this.cfgStr("username") + this.cfgStr("password"));
    this.userAgent = this.cfgStr("user_agent") || "android-ok-http-client/xl-acc-sdk/version-5.0.12.512000";
    this.downloadUserAgent = this.cfgStr("download_user_agent") || "Dalvik/2.1.0 (Linux; U; Android 12; M2004J7AC Build/SP1A.210812.016)";
    this.space = this.cfgStr("space") || "";
    this.useVideoUrl = (this.cfg as any).use_video_url || false;
    if (this.cfgStr("algorithms")) this.algorithms = this.cfgStr("algorithms").split(",");
  }

  // ---- captcha 签名（与 OpenList GetCaptchaSign 一致）----
  private getCaptchaSign(): { ts: string; sign: string } {
    if (this.algorithms.length === 0) {
      return { ts: this.cfgStr("timestamp"), sign: this.cfgStr("captcha_sign") };
    }
    const ts = String(Date.now());
    let str = this.clientID + this.clientVersion + this.packageName + this.deviceID + ts;
    for (const a of this.algorithms) str = md5Hex(str + a);
    return { ts, sign: "1." + str };
  }

  private async refreshCaptchaToken(action: string): Promise<void> {
    const { ts, sign } = this.getCaptchaSign();
    const metas: Record<string, string> = {
      client_version: this.clientVersion,
      package_name: this.packageName,
      user_id: this.userID,
      timestamp: ts,
      captcha_sign: sign,
    };
    const r = await fetch(`${XLUSER}/shield/captcha/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "user-agent": this.userAgent },
      body: JSON.stringify({
        action,
        captcha_token: this.captchaToken,
        client_id: this.clientID,
        device_id: this.deviceID,
        meta: metas,
        redirect_uri: "xlaccsdk01://xunlei.com/callback?state=harbor",
      }),
    });
    const j = (await r.json()) as any;
    if (j.url) throw new Error(`xunlei: 需要人机验证，请访问 ${j.url} 获取 captcha_token`);
    if (!j.captcha_token) throw new Error(`xunlei: 获取 captcha_token 失败 ${j.error || j.error_description || ""}`);
    this.captchaToken = j.captcha_token;
    await this.save();
  }

  private async ensureToken(): Promise<void> {
    const t = await loadTokens(this.env.KV, this.mountId);
    if (!isExpired(t) && t!.access_token) {
      this.accessToken = t!.access_token;
      this.refreshToken = t!.refresh_token || this.cfgStr("refresh_token");
      this.captchaToken = (t!.extra?.captcha_token as string) || this.cfgStr("captcha_token");
      this.userID = (t!.extra?.user_id as string) || "";
      this.deviceID = (t!.extra?.device_id as string) || this.deviceID;
      this.expiresAt = t!.expires_at;
      return;
    }
    const rt = this.cfgStr("refresh_token") || t?.refresh_token || "";
    if (!rt) throw new Error("xunlei: 缺少 refresh_token（用户名密码登录需交互式验证码，请提供 refresh_token）");
    const r = await fetch(`${XLUSER}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: rt, client_id: this.clientID, client_secret: this.clientSecret }),
    });
    const j = (await r.json()) as any;
    if (!j.access_token) throw new Error(`xunlei: 刷新令牌失败 ${j.error_description || ""}`);
    this.accessToken = j.access_token;
    this.refreshToken = j.refresh_token || rt;
    this.userID = j.user_id || "";
    this.expiresAt = Date.now() + (Number(j.expires_in) || 3600) * 1000;
    await this.save();
  }

  private async save(): Promise<void> {
    await saveTokens(this.env.KV, this.mountId, {
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      expires_at: this.expiresAt,
      extra: { captcha_token: this.captchaToken, user_id: this.userID, device_id: this.deviceID },
    });
  }

  protected async hdrs(): Promise<Record<string, string>> {
    await this.ensureToken();
    if (!this.captchaToken) await this.refreshCaptchaToken("GET:/drive/v1/files");
    return {
      authorization: `Bearer ${this.accessToken}`,
      "x-captcha-token": this.captchaToken,
      "x-device-id": this.deviceID,
      "x-client-id": this.clientID,
      "x-client-version": this.clientVersion,
      "user-agent": this.userAgent,
      accept: "application/json;charset=UTF-8",
    };
  }

  private async request(method: string, pathname: string, params: Record<string, string>, body?: unknown, retry = 0): Promise<any> {
    const h = await this.hdrs();
    const url = method === "GET" && params ? `${pathname}?${new URLSearchParams(params).toString()}` : pathname;
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json", ...h }, body: body ? JSON.stringify(body) : undefined });
    const j = (await r.json().catch(() => ({}))) as any;
    const ec = Number(j.error_code || 0);
    const em = j.error || "";
    if (ec === 0 && em === "") return j;
    if ((ec === 4122 || ec === 4121 || ec === 10 || ec === 16) && retry < 2) {
      await this.ensureToken();
      return this.request(method, pathname, params, body, retry + 1);
    }
    if (ec === 9 && retry < 2) {
      await this.refreshCaptchaToken(`${method}:${new URL(pathname).pathname}`);
      return this.request(method, pathname, params, body, retry + 1);
    }
    throw new Error(`xunlei: ${em || j.error_description || "error"} (${ec})`);
  }

  private async getFiles(folderId: string): Promise<FileItem[]> {
    const out: FileItem[] = [];
    let pageToken = "";
    for (;;) {
      const j = await this.request("GET", FILE_API, {
        space: this.space, __type: "drive", refresh: "true", __sync: "true", parent_id: folderId,
        page_token: pageToken, with_audit: "true", limit: "100",
        filters: `{"phase":{"eq":"PHASE_TYPE_COMPLETE"},"trashed":{"eq":false}}`,
      });
      for (const f of j.files || []) {
        if (f.trashed) continue;
        out.push({
          name: f.name,
          path: "", // 占位，调用方补
          is_dir: f.kind === "drive#folder",
          size: Number(f.size || 0),
          modified: f.modified_time ? new Date(f.modified_time).getTime() : 0,
          etag: f.id,
        });
      }
      if (!j.next_page_token) break;
      pageToken = j.next_page_token;
    }
    return out;
  }

  private async resolveId(path: string): Promise<string> {
    if (path === "/") return "0";
    let pdir = "0";
    for (const seg of path.split("/").filter(Boolean)) {
      const files = await this.getFiles(pdir);
      const f = files.find((x) => x.name === seg);
      if (!f) throw new Error(`xunlei: 路径不存在 ${path}`);
      pdir = f.etag!;
    }
    return pdir;
  }

  private fill(items: FileItem[], base: string): FileItem[] {
    return items.map((it) => ({ ...it, path: joinPath(base, it.name) }));
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.resolveId(path);
    const files = await this.getFiles(id);
    return this.fill(files, path);
  }

  async get(path: string): Promise<FileItem> {
    if (path === "/") return { name: "", path: "/", is_dir: true, size: 0, modified: 0 };
    const parent = path.split("/").slice(0, -1).join("/") || "/";
    const id = await this.resolveId(parent);
    const files = await this.getFiles(id);
    const name = path.split("/").pop();
    const f = files.find((x) => x.name === name);
    if (!f) throw new Error(`xunlei: 不存在 ${path}`);
    return this.fill([f], parent)[0];
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const item = await this.get(path);
    const j = await this.request("GET", `${FILE_API}/${item.etag}`, { space: this.space });
    let url = j.web_content_link;
    if (this.useVideoUrl && j.medias?.length) {
      for (const m of j.medias) if (m.link?.url) { url = m.link.url; break; }
    }
    if (!url) throw new Error("xunlei: 无下载链接");
    return fetch(url, { headers: { "User-Agent": this.downloadUserAgent, ...(range ? { Range: range } : {}) }, redirect: "follow" });
  }

  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(_path)}`, method: "PUT", headers: { "x-driver": this.id } };
  }

  // Worker 代理：GCID 秒传 + S3 直传（SigV4）
  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const parentId = await this.resolveId(path.split("/").slice(0, -1).join("/") || "/");
    const name = basename(path);
    const buf = new Uint8Array(await new Response(body).arrayBuffer());
    const gcid = await getGcid(buf);
    const j = await this.request("POST", FILE_API, {}, {
      kind: "drive#file", parent_id: parentId, name, size: buf.length, hash: gcid,
      upload_type: "UPLOAD_TYPE_RESUMABLE", space: this.space,
    });
    const p = j.resumable?.params;
    if (!p?.access_key_id) return; // 秒传
    const endpoint = p.endpoint.replace(p.bucket + ".", "");
    const uploadUrl = `https://${p.bucket}.${endpoint}/${p.key}`;
    const signed = await signS3("PUT", uploadUrl, buf, {
      accessKeyId: p.access_key_id, secretAccessKey: p.access_key_secret, sessionToken: p.security_token, region: "xunlei",
    });
    const r = await fetch(uploadUrl, { method: "PUT", headers: signed, body: buf });
    if (!r.ok) throw new Error(`xunlei: S3 上传失败 ${r.status}`);
  }

  async mkdir(path: string): Promise<void> {
    const parentId = await this.resolveId(path.split("/").slice(0, -1).join("/") || "/");
    await this.request("POST", FILE_API, {}, { kind: "drive#folder", name: basename(path), parent_id: parentId, space: this.space });
  }
  async remove(path: string): Promise<void> {
    const item = await this.get(path);
    await this.request("PATCH", `${FILE_API}/${item.etag}/trash`, { space: this.space }, {});
  }
  async rename(from: string, to: string): Promise<void> {
    const item = await this.get(from);
    await this.request("PATCH", `${FILE_API}/${item.etag}`, { space: this.space }, { name: basename(to), space: this.space });
  }
  async move(from: string, to: string): Promise<void> {
    const item = await this.get(from);
    const dest = await this.resolveId(to.split("/").slice(0, -1).join("/") || "/");
    await this.request("POST", `${FILE_API}:batchMove`, {}, { to: { parent_id: dest }, ids: [item.etag], space: this.space });
  }
}

// GCID：每块 sha1，再对块 sha1 列表做 sha1（与 OpenList getGcid 一致）
async function getGcid(buf: Uint8Array): Promise<string> {
  const size = buf.length;
  let psize = 0x40000;
  while (size / psize > 0x200 && psize < 0x200000) psize <<= 1;
  let acc = new Uint8Array(0);
  for (let off = 0; off < size; off += psize) {
    const slice = buf.slice(off, Math.min(off + psize, size));
    const h2 = new Uint8Array(await crypto.subtle.digest("SHA-1", slice));
    const o = new Uint8Array(acc.length + h2.length);
    o.set(acc); o.set(h2, acc.length);
    acc = o;
  }
  const final = new Uint8Array(await crypto.subtle.digest("SHA-1", acc));
  return [...final].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// AWS Signature V4（仅 S3 PUT 直传所需）
async function signS3(method: string, url: string, payload: Uint8Array, cred: { accessKeyId: string; secretAccessKey: string; sessionToken: string; region: string }): Promise<Record<string, string>> {
  const u = new URL(url);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 17);
  const dateStamp = amzDate.slice(0, 8);
  const service = "s3";
  const region = cred.region;
  const payloadHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", payload))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const canonicalHeaders = `host:${u.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\nx-amz-security-token:${cred.sessionToken}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date;x-amz-security-token";
  const canonicalReq = `${method}\n${u.pathname}${u.search}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalReq))))}`;
  const kDate = await hmac(`AWS4${cred.secretAccessKey}`, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));
  const auth = `${algorithm} Credential=${cred.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "x-amz-security-token": cred.sessionToken,
    Authorization: auth,
  };
}
async function hmac(key: string | Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", typeof key === "string" ? new TextEncoder().encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)));
}
function hex(buf: Uint8Array): string {
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type _Avoid = Env | DriverConfig;
