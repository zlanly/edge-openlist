import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, type TokenSet } from "../util/tokenstore";
import { md5, md5Hex } from "../util/md5";
import { bytesToBase64, bytesToHex, stringToBytes } from "../util/aes";

// 139 网盘（移动云盘）（OpenList 源码核对：drivers/139/{driver.go,util.go,meta.go,types.go}）
//
// 认证：Authorization（Basic base64，形如 "pc:<account>:<authToken>"）。若仅给用户名/密码，
//   密码登录需 3 步（mail.10086.cn 登录 → artifact 交换 → 第三方登录，含 SHA1 与
//   AES-ECB/AES-CBC 两层解密，密钥 KEY_HEX_1/KEY_HEX_2）。该流程原语（SHA1/AES）均可在
//   Worker 复刻，但较重，本批次仅支持直接提供 Authorization。
// 请求签名：mcloud-sign = calSign(JSON body, ts, rand)，其中 calSign 仅用 MD5（util/md5.ts），
//   可在 CF Worker 忠实复刻。
// 类型：personalNew/personal/family/group/share。本驱动忠实实现最常用且契约完整的
//   MetaPersonalNew（/file/* 现代 API）；其余类型端点已知（见源码），未在此批次移植。
// 上传：/file/create + getUploadUrl + PUT 分片 + /file/complete，使用 SHA256 内容哈希
//   （WebCrypto 支持），技术上可移植；但涉及整文件 SHA256 + 冲突处理，本批次未实现。

function encURI(s: string): string {
  return encodeURIComponent(s)
    .replace(/\+/g, "%20").replace(/%21/g, "!").replace(/%27/g, "'")
    .replace(/%28/g, "(").replace(/%29/g, ")").replace(/%2A/g, "*");
}
function calSign(body: string, ts: string, rand: string): string {
  const e = encURI(body);
  const sorted = e.split("").sort().join("");
  const b64 = bytesToBase64(stringToBytes(sorted));
  const a = md5Hex(stringToBytes(b64));
  const b = md5Hex(stringToBytes(md5Hex(stringToBytes(ts + ":" + rand))));
  return md5Hex(stringToBytes(a + b)).toUpperCase();
}

export class Yun139Driver extends CloudBase {
  readonly id = "139";
  private type(): string {
    return this.cfgStr("type") || "personalNew";
  }
  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  private async ensureAuth(): Promise<TokenSet> {
    let t = await loadTokens(this.env.KV, this.mountId);
    const auth = this.cfgStr("authorization") || t?.access_token || "";
    if (!auth) throw new Error("139 需要 authorization（Basic base64），或实现密码登录流程");
    if (!t || !t.access_token) {
      t = { access_token: auth, refresh_token: "", expires_at: Date.now() + 365 * 24 * 3600 * 1000, extra: {} };
    }
    t.access_token = auth;
    if (!t.extra?.personalCloudHost) {
      t.extra = { ...(t.extra || {}), ...(await this.queryRoute(auth)) };
      await saveTokens(this.env.KV, this.mountId, t);
    }
    return t;
  }

  private async queryRoute(auth: string): Promise<Record<string, string>> {
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    const rand = Math.random().toString(36).slice(2, 18);
    const body = JSON.stringify({ userInfo: { userType: 1, accountType: 1, accountName: this.cfgStr("account") || "" }, modAddrType: 1 });
    const sign = calSign(body, ts, rand);
    const headers = this.baseHeaders(auth, ts, rand, sign, "1");
    const r = await fetch("https://user-njs.yun.139.com/user/route/qryRoutePolicy", {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body,
    });
    const j = (await r.json()) as any;
    const out: Record<string, string> = {};
    for (const p of j?.data?.routePolicyList || []) {
      if (p.modName === "personal") out.personalCloudHost = p.httpsUrl;
      else if (p.modName === "group") out.groupCloudHost = p.httpsUrl;
      else if (p.modName === "family") out.familyCloudHost = p.httpsUrl;
    }
    if (!out.personalCloudHost) throw new Error("139 未获取到 PersonalCloudHost");
    return out;
  }

  private baseHeaders(auth: string, ts: string, rand: string, sign: string, svcType: string): Record<string, string> {
    return {
      Accept: "application/json, text/plain, */*",
      "CMS-DEVICE": "default",
      Authorization: "Basic " + auth,
      "mcloud-channel": "1000101",
      "mcloud-client": "10701",
      "mcloud-sign": `${ts},${rand},${sign}`,
      "mcloud-version": "7.14.0",
      Origin: "https://yun.139.com",
      Referer: "https://yun.139.com/w/",
      "x-DeviceInfo": "||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||",
      "x-huawei-channelSrc": "10000034",
      "x-inner-ntwk": "2",
      "x-m4c-caller": "PC",
      "x-m4c-src": "10002",
      "x-SvcType": svcType,
      "Inner-Hcy-Router-Https": "1",
    };
  }

  private async personalRequest(t: TokenSet, pathname: string, data: any): Promise<any> {
    const host = t.extra?.personalCloudHost as string;
    const url = host + pathname;
    const body = JSON.stringify(data);
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    const rand = Math.random().toString(36).slice(2, 18);
    const sign = calSign(body, ts, rand);
    const headers = {
      Accept: "application/json, text/plain, */*",
      Authorization: "Basic " + t.access_token,
      Caller: "web",
      "Cms-Device": "default",
      "Mcloud-Channel": "1000101",
      "Mcloud-Client": "10701",
      "Mcloud-Route": "001",
      "Mcloud-Sign": `${ts},${rand},${sign}`,
      "Mcloud-Version": "7.14.0",
      "x-DeviceInfo": "||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||",
      "x-huawei-channelSrc": "10000034",
      "x-inner-ntwk": "2",
      "x-m4c-caller": "PC",
      "x-m4c-src": "10002",
      "x-SvcType": "1",
      "X-Yun-Api-Version": "v1",
      "X-Yun-App-Channel": "10000034",
      "X-Yun-Channel-Source": "10000034",
      "X-Yun-Client-Info": "||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||dW5kZWZpbmVk||",
      "X-Yun-Module-Type": "100",
      "X-Yun-Svc-Type": "1",
    };
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
    const text = await r.text();
    if (text.startsWith("{")) {
      const j = JSON.parse(text);
      if (j && j.success === false) throw new Error("139 err: " + (j.message || ""));
      return j;
    }
    throw new Error("139 非预期响应: " + text.slice(0, 200));
  }

  async list(path: string): Promise<FileItem[]> {
    if (this.type() !== "personalNew") throw new Error(`139 类型 ${this.type()} 本批次未移植（端点见 drivers/139 源码）`);
    const t = await this.ensureAuth();
    let cursor = "";
    const out: FileItem[] = [];
    for (let page = 0; page < 100; page++) {
      const data = { imageThumbnailStyleList: ["Small", "Large"], orderBy: "updated_at", orderDirection: "DESC", pageInfo: { pageCursor: cursor, pageSize: 100 }, parentFileId: path === "/" ? "root" : (await this.resolveId(path)) };
      const j: any = await this.personalRequest(t, "/file/list", data);
      for (const it of j?.data?.items || []) {
        const isDir = it.type === "folder";
        out.push({ name: it.name, path: joinPath(path, it.name), is_dir: isDir, size: Number(it.size || 0), modified: Date.parse(it.updatedAt) || 0, etag: it.fileId });
      }
      cursor = j?.data?.nextPageCursor || "";
      if (!cursor) break;
    }
    return out;
  }

  private async resolveId(path: string): Promise<string> {
    const items = await this.list(parentPath(path));
    const it = items.find((i) => i.name === basename(path));
    if (!it) throw new Error("not found: " + path);
    return it.etag || "";
  }

  async get(path: string): Promise<FileItem> {
    return this.list(parentPath(path)).then((items) => {
      const it = items.find((i) => i.name === basename(path));
      if (!it) throw new Error("not found: " + path);
      return it;
    });
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const t = await this.ensureAuth();
    const id = await this.resolveId(path);
    const j: any = await this.personalRequest(t, "/file/getDownloadUrl", { fileId: id });
    const cdn = j?.data?.cdnUrl, cdnSwitch = j?.data?.cdnSwitch, url = j?.data?.url;
    const final = cdnSwitch ? cdn : url;
    if (!final) throw new Error("139 无下载地址");
    return fetch(final, range ? { headers: { Range: range } } : {});
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "139" } };
  }

  async putContent(): Promise<void> {
    throw new Error(
      "139 上传本批次未实现：现代路径（/file/create+getUploadUrl+PUT 分片+/file/complete）使用 SHA256 内容哈希" +
        "（WebCrypto 支持，技术上可移植），但涉及整文件 SHA256 与冲突重命名逻辑，需另行实现。",
    );
  }

  async mkdir(path: string): Promise<void> {
    const t = await this.ensureAuth();
    await this.personalRequest(t, "/file/create", {
      parentFileId: parentPath(path) === "/" ? "root" : await this.resolveId(parentPath(path)),
      name: basename(path), description: "", type: "folder", fileRenameMode: "force_rename",
    });
  }

  async remove(path: string): Promise<void> {
    const t = await this.ensureAuth();
    await this.personalRequest(t, "/recyclebin/batchTrash", { fileIds: [await this.resolveId(path)] });
  }

  async rename(from: string, to: string): Promise<void> {
    const t = await this.ensureAuth();
    await this.personalRequest(t, "/file/update", { fileId: await this.resolveId(from), name: basename(to), description: "" });
  }

  async move(from: string, to: string): Promise<void> {
    const t = await this.ensureAuth();
    await this.personalRequest(t, "/file/batchMove", { fileIds: [await this.resolveId(from)], toParentFileId: parentPath(to) === "/" ? "root" : await this.resolveId(parentPath(to)) });
  }
}

export type _Avoid = Env | DriverConfig;
