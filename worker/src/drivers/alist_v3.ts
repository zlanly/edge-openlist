import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";

// 挂载另一个 AList / OpenList 实例（调用其 /api/fs/* 与 /api/me、/api/auth/login）
// 端点与参数严格对齐 OpenList 源码 drivers/alist_v3/{driver,util}.go
export class AlistV3Driver extends CloudBase {
  readonly id = "alist_v3";
  private root = "/";
  private address = "";
  private metaPassword = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.address = (this.cfgStr("url") || "").replace(/\/$/, "");
    this.metaPassword = this.cfgStr("meta_password") || "";
    this.root = normalizePath(this.cfgStr("root") || "/");
    if (!this.address) throw new Error("alist_v3: 缺少 url");
  }

  // 上游真实路径（叠加本地 root）
  private up(p: string): string {
    const n = normalizePath(p);
    return this.root === "/" ? n : joinPath(this.root, n);
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Authorization: await this.ensureToken() };
  }

  private async ensureToken(): Promise<string> {
    const t = await loadTokens(this.env.KV, this.mountId);
    if (!isExpired(t) && t?.access_token) return t.access_token;
    const username = this.cfgStr("username");
    const password = this.cfgStr("password");
    // 若用户直接配置了 token，优先使用
    const cfgToken = this.cfgStr("token");
    if (!username && cfgToken) {
      await saveTokens(this.env.KV, this.mountId, { access_token: cfgToken, expires_at: Date.now() + 86400_000 });
      return cfgToken;
    }
    if (!username) return cfgToken || "";
    const r = await fetch(this.address + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) throw new Error(`alist_v3 登录失败 ${r.status}`);
    const j = (await r.json()) as any;
    if (j.code !== 200) throw new Error(`alist_v3 登录失败: ${j.message}`);
    const tk = (j.data?.token as string) || cfgToken || "";
    const set: TokenSet = { access_token: tk, expires_at: Date.now() + 86400_000, extra: { username } };
    await saveTokens(this.env.KV, this.mountId, set);
    return tk;
  }

  private async fsPost<T>(api: string, body: unknown): Promise<T> {
    return this.jsonPost<T>(this.address + "/api" + api, body);
  }

  async list(path: string): Promise<FileItem[]> {
    const j = await this.fsPost<{ code: number; message: string; data: { content: any[] } }>("/fs/list", {
      page: 1,
      per_page: 0,
      path: this.up(path),
      password: this.metaPassword,
      refresh: false,
    });
    if (j.code !== 200) throw new Error(`alist_v3 list: ${j.message}`);
    return (j.data.content || []).map((f) => ({
      name: f.name,
      path: joinPath(path, f.name),
      is_dir: !!f.is_dir,
      size: Number(f.size || 0),
      modified: f.modified ? new Date(f.modified).getTime() : 0,
    }));
  }

  async get(path: string): Promise<FileItem> {
    const j = await this.fsPost<{ code: number; message: string; data: any }>("/fs/get", {
      path: this.up(path),
      password: this.metaPassword,
    });
    if (j.code !== 200) throw new Error(`alist_v3 get: ${j.message}`);
    const d = j.data;
    return {
      name: basename(path),
      path,
      is_dir: !!d.is_dir,
      size: Number(d.size || 0),
      modified: d.modified ? new Date(d.modified).getTime() : 0,
    };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const j = await this.fsPost<{ code: number; message: string; data: { raw_url: string } }>("/fs/get", {
      path: this.up(path),
      password: this.metaPassword,
    });
    if (j.code !== 200) throw new Error(`alist_v3 getContent: ${j.message}`);
    const url = j.data.raw_url;
    return fetch(url, range ? { headers: { Range: range } } : {});
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    // 无法预签名，返回 Worker 代理路径，凭据留在服务端
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "alist_v3" } };
  }

  async putContent(path: string, body: ReadableStream, contentType?: string, size = 0): Promise<void> {
    const token = await this.ensureToken();
    const headers: Record<string, string> = {
      Authorization: token,
      "File-Path": this.up(path),
      Password: this.metaPassword,
      "Content-Type": contentType || "application/octet-stream",
    };
    if (size) headers["Content-Length"] = String(size);
    const r = await fetch(this.address + "/api/fs/put", { method: "PUT", headers, body });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`alist_v3 上传失败 ${r.status}: ${txt}`);
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.fsPost(this.address + "/api/fs/mkdir", { path: this.up(path) });
  }

  async remove(path: string): Promise<void> {
    await this.fsPost(this.address + "/api/fs/remove", { dir: parentPath(this.up(path)), names: [basename(path)] });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.fsPost(this.address + "/api/fs/rename", { path: this.up(from), name: basename(to) });
  }

  async move(from: string, to: string): Promise<void> {
    await this.fsPost(this.address + "/api/fs/move", {
      src_dir: parentPath(this.up(from)),
      dst_dir: this.up(parentPath(to)),
      names: [basename(from)],
    });
  }
}
