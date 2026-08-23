import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens } from "../util/tokenstore";

// 115 网盘（OpenList 源码核对：drivers/115/{driver.go,util.go,types.go,appver.go}）
//
// 重要（忠实移植声明）：OpenList 的 115 驱动把全部网络协议委托给外部 Go SDK
//   - github.com/SheltonZhu/115driver        (Pan115Client / ec115 密码学)
//   - github.com/aliyun/aliyun-oss-go-sdk/oss (上传分片)
// 该 SDK 不在本克隆中（无 vendor、无 go mod 缓存），其 HTTP 契约（ApiFileInfo /
// ApiUploadInit / ec115 ECDH 加密 / Aliyun OSS multipart）无法从源码还原。
//
// 因此本文件仅对【公开可验证】的 REST 端点做忠实封装（Cookie 登录态：UID/CID/SEID/KID），
// 覆盖 list / getContent / mkdir / remove / rename / move；上传因依赖 ec115 密文 +
// Aliyun OSS 分片（均不在 TS/Worker 可重建范围内）标记为不可实现（见 createUpload/putContent）。
const LIST = "https://webapi.115.com/files";
const DL = "https://proapi.115.com/3.0/files/download";

export class Pan115Driver extends CloudBase {
  readonly id = "115";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  private async cookie(): Promise<string> {
    let t = await loadTokens(this.env.KV, this.mountId);
    if (!t || !t.access_token) {
      const c = this.cfgStr("cookie") || "";
      if (!c) throw new Error("缺少 cookie（UID/CID/SEID/KID），请先绑定 115 登录态");
      t = { access_token: c, refresh_token: "", expires_at: Date.now() + 86400 * 1000, extra: {} };
      await saveTokens(this.env.KV, this.mountId, t);
    }
    return t.access_token;
  }
  protected async hdrs(): Promise<Record<string, string>> {
    return { Cookie: await this.cookie() };
  }

  private isDir(it: any): boolean {
    return it.t === "d" || it.ico === "d" || it.ico === "ico_dir" || it.is_dir === 1;
  }

  private async listFolder(cid: string): Promise<any[]> {
    const out: any[] = [];
    for (let offset = 0;;) {
      const j = await this.jsonGet<{ data: any[] }>(`${LIST}?cid=${cid}&o=file_name&asc=1&limit=200&offset=${offset}`);
      const page = j.data || [];
      out.push(...page);
      if (page.length < 200) break;
      offset += page.length;
    }
    return out;
  }

  private async resolveCid(path: string): Promise<string> {
    if (path === "/") return "0";
    let cid = "0";
    for (const seg of path.split("/").filter(Boolean)) {
      const item = (await this.listFolder(cid)).find((f) => f.n === seg);
      if (!item) throw new Error(`路径不存在: ${path}`);
      cid = item.cid;
    }
    return cid;
  }

  async list(path: string): Promise<FileItem[]> {
    const items = await this.listFolder(await this.resolveCid(path));
    return items.map((it) => ({
      name: it.n,
      path: joinPath(path, it.n),
      is_dir: this.isDir(it),
      size: Number(it.s || 0),
      modified: it.last_ctime ? Date.parse(it.last_ctime) : 0,
      etag: it.cid,
    }));
  }

  async get(path: string): Promise<FileItem> {
    if (path === "/") return { name: "", path: "/", is_dir: true, size: 0, modified: 0, etag: "0" };
    const parent = path.split("/").slice(0, -1).join("/") || "/";
    const cid = await this.resolveCid(parent);
    const item = (await this.listFolder(cid)).find((f) => f.n === basename(path));
    if (!item) throw new Error(`路径不存在: ${path}`);
    return { name: item.n, path, is_dir: this.isDir(item), size: Number(item.s || 0), modified: item.last_ctime ? Date.parse(item.last_ctime) : 0, etag: item.cid };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const cid = await this.resolveCid(path);
    const j = await this.jsonGet<{ data: { url: string; headers?: Record<string, string> } }>(`${DL}?file_id=${cid}`);
    const url = j.data?.url;
    if (!url) throw new Error("无法获取 115 下载地址");
    return fetch(url, range ? { headers: { Range: range, ...(j.data.headers || {}) } } : { headers: j.data.headers || {} });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    // 上传需要 ec115 ECDH 密文 + Aliyun OSS multipart（见 drivers/115/util.go rapidUpload /
    // UploadByMultipart），该协议封装在外部 Go SDK SheltonZhu/115driver，不在克隆中，
    // 无法在 CF Worker 忠实重建。返回 Worker 代理占位，由上层提示“不支持直传”。
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "115" } };
  }

  async putContent(): Promise<void> {
    throw new Error(
      "115 上传无法在 CF Worker 实现：完整协议依赖外部 Go SDK（SheltonZhu/115driver 的 ec115 ECDH 加密 + aliyun-oss-go-sdk 分片上传），源码不在本克隆中，无法忠实移植。",
    );
  }

  async mkdir(path: string): Promise<void> {
    const cid = await this.resolveCid(parentPath(path));
    await this.jsonPost(`${LIST}/add`, { pid: cid, file_name: basename(path) });
  }

  async remove(path: string): Promise<void> {
    const cid = await this.resolveCid(path);
    await this.jsonPost("https://webapi.115.com/rb/delete", { pid: "0", fid: cid });
  }

  async rename(from: string, to: string): Promise<void> {
    const cid = await this.resolveCid(from);
    await this.jsonPost("https://webapi.115.com/files/edit", { fid: cid, file_name: basename(to) });
  }

  async move(from: string, to: string): Promise<void> {
    const cid = await this.resolveCid(from);
    const dest = await this.resolveCid(parentPath(to));
    await this.jsonPost("https://webapi.115.com/files/move", { pid: dest, fids: cid });
  }
}

export type _Avoid = Env | DriverConfig;
