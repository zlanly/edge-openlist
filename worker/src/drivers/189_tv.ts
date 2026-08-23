import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, type TokenSet } from "../util/tokenstore";

// 天翼云盘 TV 版（OpenList 源码核对：drivers/189_tv/{driver.go,utils.go,help.go}）
//
// 认证：扫码登录（QR）。流程：getQrCodeUUID.action（AppKeySignature）→ 取 uuid（即二维码内容）
//   → 用户扫码后 qrcodeLoginResult.action?uuid= 得到 E189AccessToken → loginFamilyMerge.action
//   换 SessionKey/SessionSecret。全程仅用 HMAC-SHA1（AppKeySignature / SessionKeySignature），
//   无需 RSA，可在 CF Worker 复刻；但扫码是两步交互，无法在单次请求内自动完成（见 ensureSession）。
// 请求签名：SessionKeySignatureOfHmac(sessionSecret, sessionKey, method, path, date)
//   （HMAC-SHA1，无 params 加密，区别于 189pc）。
// 上传：同 189pc（HMAC+AES+MD5 可移植，commit 需整文件 MD5，本批次未实现）。

const TVAppKey = "600100885";
const TVAppSignatureSecre = "fe5734c74c2f96a38157f420b32dc995";
const TvVersion = "6.5.5";
const AndroidTV = "FAMILY_TV";
const TvChannelId = "home02";
const ApiUrl = "https://api.cloud.189.cn";

async function hmacSha1Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}
function pathOf(url: string): string {
  const m = url.match(/:\/\/[^/]+((?:\/[^/\s?#]+)*)/);
  return m ? m[1] : "";
}
function clientSuffix(): Record<string, string> {
  return {
    clientType: AndroidTV, version: TvVersion, channelId: TvChannelId,
    clientSn: "unknown", model: "PJX110", osFamily: "Android", osVersion: "35",
    networkAccessMode: "WIFI", telecomsOperator: "46011",
  };
}

export class Cloud189TVDriver extends CloudBase {
  readonly id = "189tv";
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
    if (t && t.extra?.sessionKey && t.expires_at - Date.now() > 60_000) return t;
    if (t?.access_token) {
      const sess = await this.loginFamilyMerge(t.access_token);
      t = { ...t, ...sess };
      await saveTokens(this.env.KV, this.mountId, t);
      return t;
    }
    // 无 access_token：尝试用已存的 tempUuid 换取，或生成新二维码
    if (t?.extra?.tempUuid) {
      const r = await this.signedGet(`${ApiUrl}/family/manage/qrcodeLoginResult.action?uuid=${t.extra.tempUuid}`, true);
      const j = r as any;
      if (j?.E189AccessToken) {
        const sess = await this.loginFamilyMerge(j.E189AccessToken);
        t = { access_token: j.E189AccessToken, refresh_token: "", expires_at: Date.now() + 30 * 24 * 3600 * 1000, extra: sess.extra };
        await saveTokens(this.env.KV, this.mountId, t);
        return t;
      }
      throw new Error("189tv 扫码尚未完成，请扫码后重试");
    }
    // 生成二维码
    const r = await this.signedGet(`${ApiUrl}/family/manage/getQrCodeUUID.action`, true);
    const j = r as any;
    if (!j?.Uuid) throw new Error("189tv 获取二维码失败");
    await saveTokens(this.env.KV, this.mountId, { access_token: "", refresh_token: "", expires_at: Date.now() + 86400 * 1000, extra: { tempUuid: j.Uuid } });
    throw new Error(`189tv 需要扫码登录，请用天翼云盘 App 扫描此 uuid 对应的二维码：${j.Uuid}`);
  }

  private async loginFamilyMerge(token: string): Promise<TokenSet> {
    const r = await this.signedGet(`${ApiUrl}/family/manage/loginFamilyMerge.action?e189AccessToken=${encodeURIComponent(token)}`, true);
    const j = r as any;
    if (j?.res_code && j.res_code !== 0 && String(j.res_code) !== "0") throw new Error("189tv 会话失败: " + j.res_message);
    return { access_token: token, refresh_token: "", expires_at: Date.now() + 30 * 24 * 3600 * 1000, extra: { sessionKey: j.sessionKey, sessionSecret: j.sessionSecret, familySessionKey: j.familySessionKey, familySessionSecret: j.familySessionSecret } };
  }

  // AppKey 签名（登录类请求）
  private async appKeySig(url: string): Promise<Record<string, string>> {
    const ts = Date.now();
    const sig = await hmacSha1Hex(TVAppSignatureSecre, `AppKey=${TVAppKey}&Operate=GET&RequestURI=${pathOf(url)}&Timestamp=${ts}`);
    return { Timestamp: String(ts), "X-Request-ID": crypto.randomUUID(), AppKey: TVAppKey, AppSignature: sig };
  }
  // SessionKey 签名（业务请求）
  private async sessionSig(url: string, t: TokenSet, isFamily: boolean): Promise<Record<string, string>> {
    const secret = (isFamily ? t.extra?.familySessionSecret : t.extra?.sessionSecret) as string;
    const sessionKey = (isFamily ? t.extra?.familySessionKey : t.extra?.sessionKey) as string;
    const date = new Date().toUTCString();
    const sig = await hmacSha1Hex(secret, `SessionKey=${sessionKey}&Operate=GET&RequestURI=${pathOf(url)}&Date=${date}`);
    return { Date: date, SessionKey: sessionKey, "X-Request-ID": crypto.randomUUID(), Signature: sig };
  }

  private async signedGet(url: string, appKey: boolean): Promise<any> {
    const headers = appKey ? await this.appKeySig(url) : {};
    const r = await fetch(url, { headers });
    const text = await r.text();
    if (!r.ok) throw new Error(`189tv HTTP ${r.status}: ${text.slice(0, 400)}`);
    try { return JSON.parse(text); } catch { throw new Error(`189tv 返回格式错误: ${text.slice(0, 200)}`); }
  }

  private async apiGet(url: string, q: Record<string, string>, fam: boolean): Promise<any> {
    const t = await this.ensureSession();
    const u = url + "?" + new URLSearchParams({ ...clientSuffix(), ...q });
    const headers = await this.sessionSig(u, t, fam);
    const r = await fetch(u, { headers });
    const text = await r.text();
    if (!r.ok) throw new Error(`189tv HTTP ${r.status}: ${text.slice(0, 400)}`);
    let j: any; try { j = JSON.parse(text); } catch { throw new Error(`189tv 返回格式错误: ${text.slice(0, 200)}`); }
    if (j.res_code != null && String(j.res_code) !== "0") throw new Error(`189tv err ${j.res_code}: ${j.res_message}`);
    return j;
  }

  private async apiPost(url: string, form: Record<string, string>, fam: boolean): Promise<any> {
    const t = await this.ensureSession();
    const u = url + "?" + new URLSearchParams(clientSuffix());
    const headers = await this.sessionSig(u, t, fam);
    const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(form).toString() });
    const text = await r.text();
    if (!r.ok) throw new Error(`189tv HTTP ${r.status}: ${text.slice(0, 400)}`);
    let j: any; try { j = JSON.parse(text); } catch { throw new Error(`189tv 返回格式错误: ${text.slice(0, 200)}`); }
    if (j.res_code != null && String(j.res_code) !== "0") throw new Error(`189tv err ${j.res_code}: ${j.res_message}`);
    return j;
  }

  private async apiPrefix(fam: boolean): Promise<string> {
    return ApiUrl + (fam ? "/family/file" : "");
  }
  private async resolveId(path: string): Promise<string> {
    const items = await this.list(parentPath(path));
    const it = items.find((i) => i.name === basename(path));
    if (!it) throw new Error("not found: " + path);
    return it.etag || "";
  }

  async list(path: string): Promise<FileItem[]> {
    const fam = this.isFamily();
    const folderId = path === "/" ? "-11" : await this.resolveId(path);
    const prefix = await this.apiPrefix(fam);
    const out: FileItem[] = [];
    for (let page = 1; ; page++) {
      const j: any = await this.apiGet(`${prefix}/listFiles.action`, {
        folderId, fileType: "0", mediaAttr: "0", iconOption: "5", pageNum: String(page), pageSize: "130",
        ...(fam ? { familyId: this.cfgStr("familyId"), orderBy: "1", descending: "false" } : { recursive: "0", orderBy: "filename", descending: "false" }),
      }, fam);
      const folders = j?.fileListAO?.folderList || [], files = j?.fileListAO?.fileList || [];
      for (const f of folders) out.push({ name: f.name, path: joinPath(path, f.name), is_dir: true, size: 0, modified: Date.parse(f.lastOpTime) || 0, etag: String(f.id) });
      for (const f of files) out.push({ name: f.name, path: joinPath(path, f.name), is_dir: false, size: Number(f.size || 0), modified: Date.parse(f.lastOpTime) || 0, etag: String(f.id) });
      const total = Number(j?.fileListAO?.total ?? j?.total ?? NaN);
      if (!folders.length && !files.length || folders.length + files.length < 130 || (Number.isFinite(total) && out.length >= total)) break;
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    return this.list(parentPath(path)).then((items) => {
      const it = items.find((i) => i.name === basename(path));
      if (!it) throw new Error("not found: " + path);
      return it;
    });
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const fam = this.isFamily();
    const id = await this.resolveId(path);
    const prefix = await this.apiPrefix(fam);
    const j: any = await this.apiGet(`${prefix}/getFileDownloadUrl.action`, {
      fileId: id, ...(fam ? { familyId: this.cfgStr("familyId") } : { dt: "3", flag: "1" }),
    }, fam);
    let url = (j.fileDownloadUrl || "").replace(/^http:/, "https:");
    if (!url) throw new Error("189tv 无下载地址");
    let finalUrl = url;
    for (let i = 0; i < 2; i++) {
      const head = await fetch(finalUrl, { method: "GET", redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
      if (head.status === 302 && head.headers.get("location")) finalUrl = head.headers.get("location")!;
      else break;
    }
    return fetch(finalUrl, range ? { headers: { Range: range, "User-Agent": "Mozilla/5.0" } } : { headers: { "User-Agent": "Mozilla/5.0" } });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "189tv" } };
  }

  async putContent(): Promise<void> {
    throw new Error(
      "189tv 上传本批次未实现：协议（OldUpload/StreamUpload，HMAC+AES+MD5）技术上可移植，但 commit 需整文件 MD5，与“不缓冲整文件”约束冲突，需另行实现分片缓冲。",
    );
  }

  async mkdir(path: string): Promise<void> {
    const fam = this.isFamily();
    const prefix = await this.apiPrefix(fam);
    const parentId = parentPath(path) === "/" ? "-11" : await this.resolveId(parentPath(path));
    await this.apiPost(`${prefix}/createFolder.action`, {
      folderName: basename(path), relativePath: "", ...(fam ? { familyId: this.cfgStr("familyId"), parentId } : { parentFolderId: parentId }),
    }, fam);
  }

  private async createBatchTask(type: string, taskInfos: any[], targetFolderId?: string): Promise<void> {
    const fam = this.isFamily();
    await this.apiPost(`${ApiUrl}/batch/createBatchTask.action`, {
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
    await this.apiPost(url, { [key]: it.etag ?? "", [nameKey]: basename(to) }, fam);
  }
  async move(from: string, to: string): Promise<void> {
    const it = await this.get(from);
    const destId = parentPath(to) === "/" ? "-11" : await this.resolveId(parentPath(to));
    await this.createBatchTask("MOVE", [{ fileId: it.etag, fileName: basename(from), isFolder: it.is_dir ? 1 : 0 }], destId);
  }
}

export type _Avoid = Env | DriverConfig;
