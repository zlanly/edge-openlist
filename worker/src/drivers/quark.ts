import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens } from "../util/tokenstore";

const API = "https://drive-pc.quark.cn/1/clouddrive";
const TS = () => `_=${Date.now()}`;

// 夸克网盘驱动（cookie 登录态）。注意：上传接口较复杂且易变动，putContent 为 best-effort，需真机校验。
export class QuarkDriveDriver extends CloudBase {
  readonly id = "quark";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  private async cookie(): Promise<string> {
    let t = await loadTokens(this.env.KV, this.mountId);
    if (!t || !t.access_token) {
      const c = this.cfgStr("cookie") || "";
      if (!c) throw new Error("缺少 cookie，请先绑定夸克登录态");
      t = { access_token: c, refresh_token: "", expires_at: Date.now() + 86400 * 1000 };
      await saveTokens(this.env.KV, this.mountId, t);
    }
    return t.access_token;
  }
  protected async hdrs(): Promise<Record<string, string>> {
    return { Cookie: await this.cookie() };
  }

  // 路径 -> fid（逐段列表匹配）
  private async resolveFid(path: string): Promise<string> {
    if (path === "/") return "0";
    const cookie = await this.cookie();
    let pdir = "0";
    for (const seg of path.split("/").filter(Boolean)) {
      const url = `${API}/file/sort?pr=ucpro&fr=pc&uc_param_str=&pdir_fid=${pdir}&_=${Date.now()}`;
      const r = await fetch(url, { headers: { Cookie: cookie } });
      const j = (await r.json()) as any;
      const item = (j.data?.list || []).find((f: any) => f.file_name === seg);
      if (!item) throw new Error(`路径不存在: ${path}`);
      pdir = item.fid;
    }
    return pdir;
  }

  async list(path: string): Promise<FileItem[]> {
    const pdir = await this.resolveFid(path);
    const url = `${API}/file/sort?pr=ucpro&fr=pc&uc_param_str=&pdir_fid=${pdir}&_=${Date.now()}`;
    const j = await this.jsonGet<{ data: { list: any[] } }>(url);
    return (j.data?.list || []).map((it) => ({
      name: it.file_name,
      path: joinPath(path, it.file_name),
      is_dir: it.file_type === 0 || it.dir === true || it.category === "folder",
      size: Number(it.file_size || 0),
      modified: it.updated_at ? Date.parse(it.updated_at) : 0,
      etag: it.fid,
    }));
  }

  async get(path: string): Promise<FileItem> {
    if (path === "/") return { name: "", path: "/", is_dir: true, size: 0, modified: 0, etag: "0" };
    const parent = parentPath(path);
    const pdir = await this.resolveFid(parent);
    const url = `${API}/file/sort?pr=ucpro&fr=pc&uc_param_str=&pdir_fid=${pdir}&_=${Date.now()}`;
    const j = await this.jsonGet<{ data: { list: any[] } }>(url);
    const item = (j.data?.list || []).find((f) => f.file_name === basename(path));
    if (!item) throw new Error(`路径不存在: ${path}`);
    return { name: item.file_name, path, is_dir: item.file_type === 0 || item.dir === true || item.category === "folder", size: Number(item.file_size || 0), modified: item.updated_at ? Date.parse(item.updated_at) : 0, etag: item.fid };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const fid = await this.resolveFid(path);
    const url = `${API}/file/download?pr=ucpro&fr=pc&uc_param_str=&fid=${fid}&_=${Date.now()}`;
    const j = await this.jsonGet<{ data: { download_url: string } }>(url);
    return fetch(j.data.download_url, range ? { headers: { Range: range } } : {});
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "quark" } };
  }

  // best-effort：创建条目后按上传会话逐片 PUT（具体端点需真机校验）
  async putContent(path: string, body: ReadableStream, _ct?: string, _size?: number): Promise<void> {
    const fid = await this.resolveFid(parentPath(path));
    const create = await this.jsonPost<any>(`${API}/file/create`, {
      pdir_fid: fid,
      file_name: basename(path),
      dir: false,
      size: _size || 0,
    });
    const uploadUrl = create?.data?.upload_url || create?.upload_url;
    if (!uploadUrl) throw new Error("无法获取夸克上传地址（需校验接口）");
    const r = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(_size || 0) },
      body,
    });
    if (!r.ok) throw new Error(`夸克上传失败 ${r.status}`);
  }

  async mkdir(path: string): Promise<void> {
    const fid = await this.resolveFid(parentPath(path));
    await this.jsonPost(`${API}/file?pr=ucpro&fr=pc&uc_param_str=&_=${Date.now()}`, {
      pdir_fid: fid,
      file_name: basename(path),
      dir: true,
    });
  }

  async remove(path: string): Promise<void> {
    const fid = await this.resolveFid(path);
    await this.jsonPost(`${API}/file/delete?pr=ucpro&fr=pc&uc_param_str=&_=${Date.now()}`, { fid_list: [fid] });
  }

  async rename(from: string, to: string): Promise<void> {
    const fid = await this.resolveFid(from);
    await this.jsonPost(`${API}/file/rename?pr=ucpro&fr=pc&uc_param_str=&_=${Date.now()}`, { fid, file_name: basename(to) });
  }

  async move(from: string, to: string): Promise<void> {
    const fid = await this.resolveFid(from);
    const dest = await this.resolveFid(parentPath(to));
    await this.jsonPost(`${API}/file/move?pr=ucpro&fr=pc&uc_param_str=&_=${Date.now()}`, { fid_list: [fid], pdir_fid: dest });
  }
}

export type _Avoid = Env | DriverConfig;
