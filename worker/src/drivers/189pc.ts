import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, type TokenSet } from "../util/tokenstore";
import { aesEcbEncrypt, stringToBytes, bytesToHex } from "../util/aes";

// 天翼云盘 PC 版（OpenList 源码核对：drivers/189pc/{driver.go,utils.go,help.go}）
//
// 认证：AccessToken/RefreshToken（KV 持久化）→ getSessionForPC.action 换 SessionKey/
//   SessionSecret；密码登录（RSA PKCS#1 v1.5，WebCrypto 无加密原语）与扫码登录亦支持，
//   本驱动实现 AccessToken 路径。
// 请求签名：SignatureHeader = signatureOfHmac(sessionSecret, sessionKey, method, path, date, params)
//   （HMAC-SHA1，WebCrypto 支持）；params 走 AesECBEncrypt(params, sessionSecret[:16])
//   （util/aes.ts 提供 AES-ECB，支持）。两种原语均可在 CF Worker 忠实复刻。
// 上传：initMultiUpload → getMultiUploadUrls → PUT 分片 → commitMultiUploadFile，
//   全程仅依赖 HMAC+AES+MD5（util/md5.ts 已提供），理论上可移植；但 commit 需整文件 MD5，
//   与“不缓冲整文件”约束冲突，本批次未实现（见 putContent）。

const APP_ID = "8025431004";
const CLIENT_TYPE = "10020";
const VERSION = "6.2";
const PC = "TELEPC";
const CHANNEL_ID = "web_cloud.189.cn";
const API_URL = "https://api.cloud.189.cn";
const RETURN_URL = "https://m.cloud.189.cn/zhuanti/2020/loginErrorPc/index.html";

async function hmacSha1Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToHex(new Uint8Array(sig)).toUpperCase();
}
function pathOf(url: string): string {
  const m = url.match(/:\/\/[^/]+((?:\/[^/\s?#]+)*)/);
  return m ? m[1] : "";
}
function clientSuffix(): Record<string, string> {
  const r1 = Math.floor(Math.random() * 1e5);
  const r2 = Math.floor(Math.random() * 1e10);
  return { clientType: PC, version: VERSION, channelId: CHANNEL_ID, rand: `${r1}_${r2}` };
}

export class Cloud189PCDriver extends CloudBase {
  readonly id = "189pc";
  private isFamily(): boolean {
    return this.cfgStr("type") === "family";
  }
  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  private async ensureSession(): Promise<TokenSet> {
    let t = await loadTokens(this.env.KV, this.mountId);
    if (t && t.extra?.sessionKey && !isExpiredLight(t)) return t;
    if (!t || !t.refresh_token) throw new Error("189pc 缺少 refresh_token，请先绑定 AccessToken/RefreshToken");
    // 1) refresh token
    const rf = await fetch("https://open.e.189.cn/api/oauth2/refreshToken.do", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ clientId: APP_ID, refreshToken: t.refresh_token, grantType: "refresh_token", format: "json" }).toString(),
    });
    const rfj = (await rf.json()) as any;
    if (rfj.res_code && rfj.res_code !== "0") throw new Error("189pc 刷新 token 失败: " + rfj.res_message);
    const accessToken = rfj.accessToken || t.access_token;
    const refreshToken = rfj.refreshToken || t.refresh_token;
    // 2) getSessionForPC
    const sess = await fetch(`${API_URL}/getSessionForPC.action?${new URLSearchParams({ ...clientSuffix(), accessToken, redirectURL: RETURN_URL })}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const sj = (await sess.json()) as any;
    if (sj.res_code && sj.res_code !== 0) throw new Error("189pc 会话失败: " + sj.res_message);
    t = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Date.now() + 30 * 24 * 3600 * 1000,
      extra: { sessionKey: sj.sessionKey, sessionSecret: sj.sessionSecret, familySessionKey: sj.familySessionKey, familySessionSecret: sj.familySessionSecret },
    };
    await saveTokens(this.env.KV, this.mountId, t);
    return t;
  }

  private async request(method: string, url: string, params: Record<string, string> | null, isFamily: boolean): Promise<any> {
    const t = await this.ensureSession();
    const secret = (isFamily ? t.extra?.familySessionSecret : t.extra?.sessionSecret) as string;
    const sessionKey = (isFamily ? t.extra?.familySessionKey : t.extra?.sessionKey) as string;
    const q = new URLSearchParams(clientSuffix());
    let encParam = "";
    if (params) {
      const enc = await aesEcbEncrypt(stringToBytes(new URLSearchParams(params).toString()), stringToBytes(secret.slice(0, 16)));
      encParam = bytesToHex(enc).toUpperCase();
      q.set("params", encParam);
    }
    const date = new Date().toUTCString();
    const sig = await hmacSha1Hex(secret, `SessionKey=${sessionKey}&Operate=${method}&RequestURI=${pathOf(url)}&Date=${date}` + (encParam ? `&params=${encParam}` : ""));
    const headers: Record<string, string> = { Date: date, SessionKey: sessionKey, "X-Request-ID": crypto.randomUUID(), Signature: sig };
    const r = await fetch(url, { method, headers, body: method === "POST" ? new URLSearchParams(params || {}).toString() : undefined });
    const text = await r.text();
    if (!r.ok) throw new Error(`189pc HTTP ${r.status}: ${text.slice(0, 500)}`);
    if (text.includes("InvalidSessionKey") || text.includes("userSessionBO is null")) {
      const current = await loadTokens(this.env.KV, this.mountId);
      if (current) await saveTokens(this.env.KV, this.mountId, { ...current, expires_at: 0, extra: {} });
      throw new Error("189pc 会话已失效，请刷新会话后重试");
    }
    let j: any;
    try { j = JSON.parse(text); } catch { return text; }
    if (j.res_code != null && String(j.res_code) !== "0") throw new Error(`189pc err ${j.res_code}: ${j.res_message}`);
    return j;

  }

  private async apiPrefix(isFamily: boolean): Promise<string> {
    return API_URL + (isFamily ? "/family/file" : "");
  }

  async list(path: string): Promise<FileItem[]> {
    const fam = this.isFamily();
    const folderId = path === "/" ? "-11" : await this.resolveId(path);
    const prefix = await this.apiPrefix(fam);
    const j: any = await this.request("GET", `${prefix}/listFiles.action`, {
      folderId, fileType: "0", mediaAttr: "0", iconOption: "5", pageNum: "1", pageSize: "1000",
      ...(fam ? { familyId: this.cfgStr("familyId"), orderBy: "1", descending: "false" } : { recursive: "0", orderBy: "filename", descending: "false" }),
    }, fam);
    const out: FileItem[] = [];
    for (const f of j?.fileListAO?.folderList || []) out.push({ name: f.name, path: joinPath(path, f.name), is_dir: true, size: 0, modified: Date.parse(f.lastOpTime) || 0, etag: String(f.id) });
    for (const f of j?.fileListAO?.fileList || []) out.push({ name: f.name, path: joinPath(path, f.name), is_dir: false, size: Number(f.size || 0), modified: Date.parse(f.lastOpTime) || 0, etag: String(f.id) });
    return out;
  }

  private async resolveId(path: string): Promise<string> {
    const parent = parentPath(path);
    const name = basename(path);
    const items = await this.list(parent === "/" ? "/" : parent);
    const it = items.find((i) => i.name === name);
    if (!it) throw new Error("not found: " + path);
    return it.etag || "";
  }

  async get(path: string): Promise<FileItem> {
    const items = await this.list(parentPath(path));
    const it = items.find((i) => i.name === basename(path));
    if (!it) throw new Error("not found: " + path);
    return it;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const fam = this.isFamily();
    const id = (await this.get(path)).etag || "";
    const prefix = await this.apiPrefix(fam);
    const j: any = await this.request("GET", `${prefix}/getFileDownloadUrl.action`, {
      fileId: id, ...(fam ? { familyId: this.cfgStr("familyId") } : { dt: "3", flag: "1" }),
    }, fam);
    let url = (j.fileDownloadUrl || "").replace(/^http:/, "https:");
    if (!url) throw new Error("189pc 无下载地址");
    let finalUrl = url;
    for (let i = 0; i < 2; i++) {
      const head = await fetch(finalUrl, { method: "GET", redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
      if (head.status === 302 && head.headers.get("location")) finalUrl = head.headers.get("location")!;
      else break;
    }
    return fetch(finalUrl, range ? { headers: { Range: range, "User-Agent": "Mozilla/5.0" } } : { headers: { "User-Agent": "Mozilla/5.0" } });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "189pc" } };
  }

  async putContent(): Promise<void> {
    throw new Error(
      "189pc 上传本批次未实现：协议（initMultiUpload→getMultiUploadUrls→PUT 分片→commitMultiUploadFile）" +
        "仅依赖 HMAC-SHA1+AES-ECB+MD5（均可在 Worker 复刻），但 commit 需整文件 MD5，与“不缓冲整文件”约束冲突；技术上可移植，需另行实现分片缓冲。",
    );
  }

  async mkdir(path: string): Promise<void> {
    const fam = this.isFamily();
    const prefix = await this.apiPrefix(fam);
    const parentId = parentPath(path) === "/" ? "-11" : await this.resolveId(parentPath(path));
    await this.request("POST", `${prefix}/createFolder.action`, {
      folderName: basename(path), relativePath: "", ...(fam ? { familyId: this.cfgStr("familyId"), parentId } : { parentFolderId: parentId }),
    }, fam);
  }

  private async createBatchTask(type: string, taskInfos: any[], targetFolderId?: string): Promise<void> {
    const fam = this.isFamily();
    await this.request("POST", `${API_URL}/batch/createBatchTask.action`, {
      type,
      taskInfos: JSON.stringify(taskInfos),
      ...(targetFolderId ? { targetFolderId } : {}),
      ...(fam ? { familyId: this.cfgStr("familyId") } : {}),
    }, fam);
  }

  async remove(path: string): Promise<void> {
    const it = await this.get(path);
    await this.createBatchTask("DELETE", [{ fileId: it.etag, fileName: basename(path), isFolder: it.is_dir ? 1 : 0 }]);
  }
  async rename(from: string, to: string): Promise<void> {
    const it = await this.get(from);
    const fam = this.isFamily();
    const prefix = await this.apiPrefix(fam);
    const url = it.is_dir ? `${prefix}/renameFolder.action` : `${prefix}/renameFile.action`;
    const key = it.is_dir ? "folderId" : "fileId";
    const nameKey = it.is_dir ? "destFolderName" : "destFileName";
    await this.request("POST", url, { [key]: it.etag ?? "", [nameKey]: basename(to) }, fam);
  }
  async move(from: string, to: string): Promise<void> {
    const it = await this.get(from);
    const destId = parentPath(to) === "/" ? "-11" : await this.resolveId(parentPath(to));
    await this.createBatchTask("MOVE", [{ fileId: it.etag, fileName: basename(from), isFolder: it.is_dir ? 1 : 0 }], destId);
  }
}

function isExpiredLight(t: TokenSet): boolean {
  return t.expires_at - Date.now() < 60_000;
}

export type _Avoid = Env | DriverConfig;
