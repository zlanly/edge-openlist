import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens } from "../util/tokenstore";

const LIST = "https://webapi.115.com/files";
const DL = "https://proapi.115.com/3.0/files/download";

// 115 网盘驱动（cookie 登录态：UID/CID/SEID 等）。上传接口 best-effort，需真机校验。
export class P115DriveDriver extends CloudBase {
  readonly id = "p115";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  private async cookie(): Promise<string> {
    let t = await loadTokens(this.env.KV, this.mountId);
    if (!t || !t.access_token) {
      const c = this.cfgStr("cookie") || "";
      if (!c) throw new Error("缺少 cookie，请先绑定 115 登录态");
      t = { access_token: c, refresh_token: "", expires_at: Date.now() + 86400 * 1000 };
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

  private async resolveCid(path: string): Promise<string> {
    if (path === "/") return "0";
    const cookie = await this.cookie();
    let cid = "0";
    for (const seg of path.split("/").filter(Boolean)) {
      const url = `${LIST}?cid=${cid}&o=file_name&asc=1&limit=200&offset=0`;
      const r = await fetch(url, { headers: { Cookie: cookie } });
      const j = (await r.json()) as any;
      const item = (j.data || []).find((f: any) => f.n === seg);
      if (!item) throw new Error(`路径不存在: ${path}`);
      cid = item.cid;
    }
    return cid;
  }

  async list(path: string): Promise<FileItem[]> {
    const cid = await this.resolveCid(path);
    const url = `${LIST}?cid=${cid}&o=file_name&asc=1&limit=200&offset=0`;
    const j = await this.jsonGet<{ data: any[] }>(url);
    return (j.data || []).map((it) => ({
      name: it.n,
      path: joinPath(path, it.n),
      is_dir: this.isDir(it),
      size: Number(it.s || 0),
      modified: it.last_ctime ? Date.parse(it.last_ctime) : 0,
      etag: it.cid,
    }));
  }

  async get(path: string): Promise<FileItem> {
    const cid = await this.resolveCid(path);
    return { name: basename(path), path, is_dir: false, size: 0, modified: 0, etag: cid };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const cid = await this.resolveCid(path);
    const j = await this.jsonGet<{ data: { url: string } }>(`${DL}?file_id=${cid}`);
    return fetch(j.data.url, range ? { headers: { Range: range } } : {});
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "p115" } };
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, _size?: number): Promise<void> {
    const cid = await this.resolveCid(parentPath(path));
    const create = await this.jsonPost<any>(`${LIST}/add`, { pid: cid, file_name: basename(path) });
    const uploadUrl = create?.data?.upload_url || create?.upload_url;
    if (!uploadUrl) throw new Error("无法获取 115 上传地址（需校验接口）");
    const r = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(_size || 0) },
      body,
    });
    if (!r.ok) throw new Error(`115 上传失败 ${r.status}`);
  }

  async mkdir(path: string): Promise<void> {
    const cid = await this.resolveCid(parentPath(path));
    await this.jsonPost(`${LIST}/add`, { pid: cid, file_name: basename(path) });
  }

  async remove(path: string): Promise<void> {
    const cid = await this.resolveCid(path);
    await this.jsonPost(`https://webapi.115.com/rb/delete`, { pid: "0", fid: cid });
  }

  async rename(from: string, to: string): Promise<void> {
    const cid = await this.resolveCid(from);
    await this.jsonPost(`https://webapi.115.com/files/edit`, { fid: cid, file_name: basename(to) });
  }

  async move(from: string, to: string): Promise<void> {
    const cid = await this.resolveCid(from);
    const dest = await this.resolveCid(parentPath(to));
    await this.jsonPost(`https://webapi.115.com/files/move`, { pid: dest, fids: cid });
  }
}

export type _Avoid = Env | DriverConfig;
