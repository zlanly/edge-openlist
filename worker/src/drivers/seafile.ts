import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";
import { buildMultipart } from "./multipart";

// Seafile（token 登录 + 上传/下载会话）。端点与参数按 OpenList drivers/seafile 移植。
// 列表=/api2/repos/{id}/dir/，下载=/api2/repos/{id}/file/，上传=取 upload-link 后 multipart。
export class SeafileDriver extends CloudBase {
  readonly id = "seafile";
  private address = "";
  private token = "";
  private repoId = "";
  private root = "/";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.address = (this.cfgStr("address") || "").replace(/\/+$/, "");
    this.root = normalizePath(this.cfgStr("root_folder_path") || "/");
    const t = await loadTokens(this.env.KV, this.mountId);
    if (t?.access_token) this.token = t.access_token;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Authorization: `Token ${this.token}` };
  }

  private fullPath(path: string): string {
    return normalizePath(joinPath(this.root, path));
  }

  private async resolveRepo(): Promise<string> {
    if (this.repoId) return this.repoId;
    const resp = (await this.jsonGet<any[]>("/api2/repos/")) as any[];
    const rootName = this.root.replace(/^\//, "").split("/")[0];
    const repo = resp.find((r) => r.name === rootName);
    if (!repo) throw new Error(`Seafile 未找到资料库: ${rootName}`);
    this.repoId = repo.id;
    return this.repoId;
  }

  private async ensureToken(): Promise<void> {
    if (this.token) return;
    const tok = this.cfgStr("token");
    if (tok) {
      this.token = tok;
      return;
    }
    const r = await fetch(`${this.address}/api2/auth-token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: this.cfgStr("username"), password: this.cfgStr("password") }).toString(),
    });
    if (!r.ok) throw new Error(`Seafile 登录失败: ${r.status}`);
    const j = (await r.json()) as any;
    this.token = j.token;
    const t: TokenSet = { access_token: j.token, expires_at: Date.now() + 86400 * 1000 };
    await saveTokens(this.env.KV, this.mountId, t);
  }

  private async authed(method: string, path: string, opts: { query?: Record<string, string>; body?: BodyInit; form?: Record<string, string> } = {}): Promise<any> {
    await this.ensureToken();
    for (let i = 0; i < 2; i++) {
      const url = new URL(this.address + path);
      if (opts.query) for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
      const headers: Record<string, string> = { Authorization: `Token ${this.token}` };
      let body = opts.body;
      if (opts.form) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(opts.form).toString();
      }
      const r = await fetch(url.toString(), { method, headers, body });
      if (r.status !== 401) {
        if (!r.ok) throw new Error(`Seafile ${method} ${path} 失败: ${r.status}`);
        return r;
      }
      this.token = "";
      await this.ensureToken();
    }
    throw new Error("Seafile 鉴权失败");
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.resolveRepo();
    const r = await this.authed("GET", `/api2/repos/${id}/dir/`, { query: { p: this.fullPath(path) } });
    const arr = (await r.json()) as any[];
    return arr.map((it) => ({
      name: it.name,
      path: joinPath(path, it.name),
      is_dir: it.type === "dir",
      size: Number(it.size || 0),
      modified: it.mtime ? it.mtime * 1000 : 0,
    }));
  }

  async get(path: string): Promise<FileItem> {
    const id = await this.resolveRepo();
    const items = (await this.authed("GET", `/api2/repos/${id}/dir/`, { query: { p: this.fullPath(parentPath(path)) } }).then((r) => r.json())) as any[];
    const name = basename(path);
    const it = items.find((i) => i.name === name);
    if (!it) throw new Error("文件不存在");
    return { name, path, is_dir: it.type === "dir", size: Number(it.size || 0), modified: it.mtime ? it.mtime * 1000 : 0 };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const id = await this.resolveRepo();
    const r = await this.authed("GET", `/api2/repos/${id}/file/`, { query: { p: this.fullPath(path), reuse: "1" } });
    let url = (await r.text()).trim();
    url = url.replace(/^"|"$/g, "");
    return fetch(url, range ? { headers: { Range: range } } : {});
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "seafile" } };
  }

  async putContent(path: string, stream: ReadableStream, _ct?: string, _size = 0): Promise<void> {
    const id = await this.resolveRepo();
    const parent = this.fullPath(parentPath(path));
    const linkR = await this.authed("GET", `/api2/repos/${id}/upload-link/`, { query: { p: parent } });
    let link = (await linkR.text()).trim().replace(/^"|"$/g, "");
    const mp = buildMultipart(
      { parent_dir: parent, replace: "1" },
      { name: basename(path), stream: stream as ReadableStream<Uint8Array> }
    );
    const r = await fetch(link, {
      method: "POST",
      headers: { Authorization: `Token ${this.token}`, "Content-Type": mp.contentType },
      body: mp.body,
    });
    if (!r.ok) throw new Error(`Seafile 上传失败: ${r.status}`);
  }

  async mkdir(path: string): Promise<void> {
    const id = await this.resolveRepo();
    await this.authed("POST", `/api2/repos/${id}/dir/`, { form: { p: this.fullPath(path), operation: "mkdir" } });
  }

  async remove(path: string): Promise<void> {
    const id = await this.resolveRepo();
    await this.authed("DELETE", `/api2/repos/${id}/file/`, { query: { p: this.fullPath(path) } });
  }

  async rename(from: string, to: string): Promise<void> {
    const id = await this.resolveRepo();
    await this.authed("POST", `/api2/repos/${id}/file/`, {
      query: { p: this.fullPath(from) },
      form: { operation: "rename", newname: basename(to) },
    });
  }

  async move(from: string, to: string): Promise<void> {
    const id = await this.resolveRepo();
    await this.authed("POST", `/api2/repos/${id}/file/`, {
      query: { p: this.fullPath(from) },
      form: { operation: "move", dst_repo: id, dst_dir: this.fullPath(parentPath(to)) },
    });
  }
}
