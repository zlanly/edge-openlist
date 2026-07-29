// Yandex 磁盘（OAuth + WebDAV 风格 REST）。端点移植自 OpenList drivers/yandex_disk/*。
import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";

const API = "https://cloud-api.yandex.net/v1/disk/resources";

export class YandexDiskDriver extends CloudBase {
  readonly id = "yandex_disk";
  private accessToken = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  private get orderBy(): string {
    return this.cfgStr("order_by") || "";
  }
  private get orderDir(): string {
    return this.cfgStr("order_direction") || "asc";
  }

  private async refresh(): Promise<void> {
    if (this.cfgStr("use_online_api") === "true" && this.cfgStr("api_url_address")) {
      const u = this.cfgStr("api_url_address");
      const r = await fetch(`${u}?refresh_ui=${encodeURIComponent(this.cfgStr("refresh_token"))}&server_use=true&driver_txt=yandexui_go`);
      const j = (await r.json()) as any;
      if (!j.refresh_token || !j.access_token)
        throw new Error(`yandex 在线刷新失败: ${j.text || "empty token"}`);
      this.accessToken = j.access_token;
      await saveTokens(this.env.KV, this.mountId, {
        access_token: j.access_token,
        refresh_token: j.refresh_token,
        expires_at: Date.now() + 3600 * 1000,
        extra: j,
      });
      return;
    }
    if (!this.cfgStr("client_id") || !this.cfgStr("client_secret"))
      throw new Error("yandex 缺少 client_id / client_secret");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.cfgStr("refresh_token"),
      client_id: this.cfgStr("client_id"),
      client_secret: this.cfgStr("client_secret"),
    });
    const r = await fetch("https://oauth.yandex.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!r.ok) throw new Error(`yandex 刷新失败 ${r.status}`);
    const j = (await r.json()) as any;
    if (j.error) throw new Error(`${j.error}: ${j.error_description}`);
    this.accessToken = j.access_token;
    await saveTokens(this.env.KV, this.mountId, {
      access_token: j.access_token,
      refresh_token: j.refresh_token || this.cfgStr("refresh_token"),
      expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
      extra: j,
    });
  }

  private async ensureToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const t = await loadTokens(this.env.KV, this.mountId);
    if (isExpired(t)) await this.refresh();
    else this.accessToken = t!.access_token;
    return this.accessToken;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Authorization: `OAuth ${await this.ensureToken()}` };
  }

  private async api<T>(pathname: string, method: string, query?: Record<string, string>): Promise<T> {
    const u = new URL(API + pathname);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, v);
    const r = await fetch(u.toString(), { method, headers: await this.hdrs() });
    const j = (await r.json().catch(() => ({}))) as any;
    if (j.error) {
      if (j.error === "UnauthorizedError") {
        await this.refresh();
        return this.api<T>(pathname, method, query);
      }
      throw new Error(`yandex: ${j.description || j.error}`);
    }
    return j as T;
  }

  async list(path: string): Promise<FileItem[]> {
    const out: FileItem[] = [];
    const limit = 100;
    for (let page = 1; ; page++) {
      const offset = (page - 1) * limit;
      const q: Record<string, string> = { path: normalizePath(path), limit: String(limit), offset: String(offset) };
      if (this.orderBy) q["sort"] = this.orderDir === "desc" ? "-" + this.orderBy : this.orderBy;
      const j = await this.api<any>("", "GET", q);
      const items = j?._embedded?.items || [];
      for (const f of items) {
        out.push({
          name: f.name,
          path: joinPath(path, f.name),
          is_dir: f.type === "dir",
          size: Number(f.size || 0),
          modified: f.modified ? Date.parse(f.modified) : 0,
          etag: f.path,
        });
      }
      const total = Number(j?._embedded?.total || 0);
      if (total <= offset + limit) break;
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    const parent = parentPath(path);
    const items = await this.list(parent);
    const it = items.find((i) => i.path === path);
    if (!it) throw new Error("not found: " + path);
    return it;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const j = await this.api<any>("/download", "GET", { path: normalizePath(path) });
    const h: Record<string, string> = {};
    if (range) h["Range"] = range;
    return fetch(j.href, { headers: h });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "yandex_disk" } };
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const j = await this.api<any>("/upload", "GET", { path: joinPath(parentPath(path), basename(path)), overwrite: "true" });
    const r = await fetch(j.href, {
      method: j.method || "PUT",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(size) },
      body,
    });
    if (!r.ok && r.status !== 201) throw new Error(`yandex 上传失败 ${r.status}`);
  }

  async mkdir(path: string): Promise<void> {
    await this.api("", "PUT", { path: joinPath(parentPath(path), basename(path)) });
  }

  async remove(path: string): Promise<void> {
    await this.api("", "DELETE", { path: normalizePath(path) });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.api("/move", "POST", {
      from: normalizePath(from),
      path: joinPath(parentPath(from), basename(to)),
      overwrite: "true",
    });
  }

  async move(from: string, to: string): Promise<void> {
    await this.api("/move", "POST", {
      from: normalizePath(from),
      path: joinPath(parentPath(to), basename(from)),
      overwrite: "true",
    });
  }
}

export type _Avoid = Env | DriverConfig;
