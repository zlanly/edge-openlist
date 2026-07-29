import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, type TokenSet } from "../util/tokenstore";
import { buildMultipart } from "./multipart";

// KodBox（可道云，类自有 form API）。端点/参数按 OpenList drivers/kodbox 移植。
// 登录拿 accessToken（存 KV），所有请求带 accessToken 表单字段；code="10001" 时重登。
interface CommonResp {
  code: boolean | string;
  data: any;
  info: any;
}

export class KodBoxDriver extends CloudBase {
  readonly id = "kodbox";
  private address = "";
  private authorization = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.address = (this.cfgStr("address") || "").replace(/\/+$/, "");
    const t = await loadTokens(this.env.KV, this.mountId);
    if (t?.access_token) this.authorization = t.access_token;
    await this.ensureToken();
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  private async ensureToken(): Promise<void> {
    if (this.authorization) return;
    if (this.cfgStr("username")) await this.login();
    else if (this.cfgStr("password")) await this.login();
  }

  private async login(): Promise<void> {
    const url = `${this.address}/?user/index/loginSubmit`;
    const u = new URL(url);
    u.searchParams.set("name", this.cfgStr("username"));
    u.searchParams.set("password", this.cfgStr("password"));
    const r = await fetch(u.toString(), { method: "POST" });
    if (!r.ok) throw new Error(`KodBox 登录失败: ${r.status}`);
    const j = (await r.json()) as CommonResp;
    if (j.code !== true && j.code !== true as any) {
      // code 可能为 false
    }
    if (typeof j.code === "boolean" && !j.code) throw new Error(`KodBox 登录失败: ${JSON.stringify(j.data)}`);
    this.authorization = String(j.info);
    const t: TokenSet = { access_token: this.authorization, expires_at: Date.now() + 86400 * 1000 * 7 };
    await saveTokens(this.env.KV, this.mountId, t);
  }

  private async form(pathname: string, fields: Record<string, string>, retry = true): Promise<CommonResp> {
    await this.ensureToken();
    const u = `${this.address}${pathname}`;
    const body = new URLSearchParams({ accessToken: this.authorization, ...fields }).toString();
    const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    if (!r.ok) throw new Error(`KodBox ${pathname} 失败: ${r.status}`);
    const j = (await r.json()) as CommonResp;
    if (typeof j.code === "string" && j.code === "10001") {
      if (retry) {
        this.authorization = "";
        await this.ensureToken();
        return this.form(pathname, fields, false);
      }
      throw new Error("KodBox 会话失效");
    }
    if (typeof j.code === "boolean" && !j.code) throw new Error(`KodBox 错误: ${JSON.stringify(j.data)}`);
    return j;
  }

  async list(path: string): Promise<FileItem[]> {
    const r = await this.form("/?explorer/list/path", { path: normalizePath(path) });
    const data = r.data;
    const folders = data.folderList || [];
    const files = data.fileList || [];
    const toItem = (f: any): FileItem => ({
      name: f.name,
      path: joinPath(path, f.name),
      is_dir: f.type === "folder",
      size: Number(f.size || 0),
      modified: (f.modifyTime || 0) * 1000,
    });
    return [...folders.map(toItem), ...files.map(toItem)];
  }

  async get(path: string): Promise<FileItem> {
    const items = await this.list(parentPath(path));
    const name = basename(path);
    const it = items.find((i) => i.name === name);
    if (!it) throw new Error("文件不存在");
    return it;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const url = `${this.address}/?explorer/index/fileOut&path=${encodeURIComponent(normalizePath(path))}&download=1&accessToken=${this.authorization}`;
    return fetch(url, range ? { headers: { Range: range } } : {});
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "kodbox" } };
  }

  async putContent(path: string, stream: ReadableStream, _ct?: string, _size = 0): Promise<void> {
    const mp = buildMultipart({ path: normalizePath(parentPath(path)) }, { name: basename(path), stream: stream as ReadableStream<Uint8Array> });
    const r = await fetch(`${this.address}/?explorer/upload/fileUpload`, {
      method: "POST",
      headers: { "Content-Type": mp.contentType },
      body: mp.body,
    });
    if (!r.ok) throw new Error(`KodBox 上传失败: ${r.status}`);
    const j = (await r.json()) as CommonResp;
    if (typeof j.code === "boolean" && !j.code) throw new Error(`KodBox 上传错误: ${JSON.stringify(j.data)}`);
  }

  async mkdir(path: string): Promise<void> {
    await this.form("/?explorer/index/mkdir", { path: normalizePath(path) });
  }

  async remove(path: string): Promise<void> {
    await this.form("/?explorer/index/pathDelete", {
      dataArr: JSON.stringify([{ path: normalizePath(path), name: basename(path) }]),
      shiftDelete: "1",
    });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.form("/?explorer/index/pathRename", { path: normalizePath(from), newName: basename(to) });
  }

  async move(from: string, to: string): Promise<void> {
    await this.form("/?explorer/index/pathCuteTo", {
      dataArr: JSON.stringify([{ path: normalizePath(from), name: basename(from) }]),
      path: normalizePath(parentPath(to)),
    });
  }
}
