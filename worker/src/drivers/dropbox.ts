// Dropbox（OAuth2 + 分片上传会话）。端点移植自 OpenList drivers/dropbox/*。
import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";

const BASE = "https://api.dropboxapi.com";
const CONTENT = "https://content.dropboxapi.com";

export class DropboxDriver extends CloudBase {
  readonly id = "dropbox";
  private accessToken = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  private get rootNs(): string {
    return this.cfgStr("RootNamespaceId") || "";
  }
  private rootHeader(): Record<string, string> {
    return this.rootNs
      ? { "Dropbox-API-Path-Root": JSON.stringify({ ".tag": "root", root: this.rootNs }) }
      : {};
  }

  private async refresh(): Promise<void> {
    if (this.cfgStr("use_online_api") === "true" && this.cfgStr("api_url_address")) {
      const u = this.cfgStr("api_url_address");
      const r = await fetch(`${u}?refresh_ui=${encodeURIComponent(this.cfgStr("refresh_token"))}&server_use=true&driver_txt=dropboxs_go`);
      const j = (await r.json()) as any;
      if (!j.refresh_token || !j.access_token)
        throw new Error(`dropbox 在线刷新失败: ${j.text || "empty token"}`);
      this.accessToken = j.access_token;
      await saveTokens(this.env.KV, this.mountId, {
        access_token: j.access_token,
        refresh_token: j.refresh_token,
        expires_at: Date.now() + 3600 * 1000,
        extra: j,
      });
      return;
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.cfgStr("refresh_token"),
      client_id: this.cfgStr("client_id") || "",
      client_secret: this.cfgStr("client_secret") || "",
    });
    const r = await fetch(`${BASE}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!r.ok) throw new Error(`dropbox 刷新失败 ${r.status}: ${await r.text().catch(() => "")}`);
    const j = (await r.json()) as any;
    this.accessToken = j.access_token;
    await saveTokens(this.env.KV, this.mountId, {
      access_token: j.access_token,
      expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
      extra: j,
    });
  }

  private async ensureToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const t = await loadTokens(this.env.KV, this.mountId);
    if (isExpired(t)) {
      await this.refresh();
    } else {
      this.accessToken = t!.access_token;
    }
    return this.accessToken;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.ensureToken()}`, ...this.rootHeader() };
  }

  private async api<T>(uri: string, body: any, retry = true): Promise<T> {
    const r = await fetch(BASE + uri, {
      method: "POST",
      headers: { ...(await this.hdrs()), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      if (retry && /expired_access_token|invalid_access_token|authorization/i.test(txt)) {
        await this.refresh();
        return this.api<T>(uri, body, false);
      }
      throw new Error(`dropbox ${r.status}: ${txt}`);
    }
    return (await r.json()) as T;
  }

  private async getItem(path: string): Promise<FileItem> {
    const parent = parentPath(path);
    const items = await this.list(parent);
    const it = items.find((i) => i.path === path);
    if (!it) throw new Error("not found: " + path);
    return it;
  }

  async list(path: string): Promise<FileItem[]> {
    const out: FileItem[] = [];
    let cursor = "";
    let hasMore = true;
    const first = await this.api<any>("/2/files/list_folder", {
      include_deleted: false,
      include_has_explicit_shared_members: false,
      include_mounted_folders: false,
      include_non_downloadable_files: false,
      limit: 2000,
      path: normalizePath(path),
      recursive: false,
    });
    cursor = first.cursor;
    hasMore = first.has_more;
    out.push(...first.entries.map((e: any) => fileToObj(e)));
    while (hasMore) {
      const j = await this.api<any>("/2/files/list_folder/continue", { cursor });
      cursor = j.cursor;
      hasMore = j.has_more;
      out.push(...j.entries.map((e: any) => fileToObj(e)));
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    return this.getItem(path);
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const j = await this.api<any>("/2/files/get_temporary_link", { path: normalizePath(path) });
    const h: Record<string, string> = {};
    if (range) h["Range"] = range;
    return fetch(j.link, { headers: h });
  }

  // 上传：start -> append_v2 分片 -> finish（Worker 代理流式）
  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "dropbox" } };
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const token = await this.ensureToken();
    const startRes = await fetch(`${CONTENT}/2/files/upload_session/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "Dropbox-API-Arg": JSON.stringify({ close: false }), ...this.rootHeader() },
    });
    if (!startRes.ok) throw new Error(`dropbox 起始会话失败 ${startRes.status}`);
    const sessionId = (await startRes.json() as any).session_id as string;

    const PART = 20 * 1024 * 1024;
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    let buf = new Uint8Array(0);
    let offset = 0;
    const uploadPart = async (data: Uint8Array) => {
      const arg = {
        cursor: { session_id: sessionId, offset },
        close: false,
      };
      const r = await fetch(`${CONTENT}/2/files/upload_session/append_v2`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify(arg),
          ...this.rootHeader(),
        },
        body: data,
      });
      if (!r.ok) throw new Error(`dropbox 分片失败 ${r.status}`);
      offset += data.length;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf, 0);
      merged.set(value, buf.length);
      buf = merged;
      while (buf.length >= PART) {
        await uploadPart(buf.slice(0, PART));
        buf = buf.slice(PART);
      }
    }
    if (buf.length > 0) await uploadPart(buf);
    const arg = {
      cursor: { session_id: sessionId, offset },
      commit: { path: normalizePath(path), mode: "add", autorename: true, mute: false },
    };
    const r = await fetch(`${CONTENT}/2/files/upload_session/finish`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify(arg),
        ...this.rootHeader(),
      },
    });
    if (!r.ok) throw new Error(`dropbox 完成会话失败 ${r.status}: ${await r.text().catch(() => "")}`);
  }

  async mkdir(path: string): Promise<void> {
    await this.api("/2/files/create_folder_v2", {
      autorename: false,
      path: normalizePath(parentPath(path)) + "/" + basename(path),
    });
  }

  async remove(path: string): Promise<void> {
    const it = await this.getItem(path);
    await this.api("/2/files/delete_v2", { path: it.etag || normalizePath(path) });
  }

  async rename(from: string, to: string): Promise<void> {
    const it = await this.getItem(from);
    await this.api("/2/files/move_v2", {
      allow_ownership_transfer: false,
      allow_shared_folder: false,
      autorename: false,
      from_path: it.etag || normalizePath(from),
      to_path: normalizePath(parentPath(to)) + "/" + basename(to),
    });
  }

  async move(from: string, to: string): Promise<void> {
    const it = await this.getItem(from);
    await this.api("/2/files/move_v2", {
      allow_ownership_transfer: false,
      allow_shared_folder: false,
      autorename: false,
      from_path: it.etag || normalizePath(from),
      to_path: normalizePath(parentPath(to)) + "/" + basename(to),
    });
  }
}

function fileToObj(e: any): FileItem {
  return {
    name: e.name,
    path: e.path_display,
    is_dir: e[".tag"] === "folder",
    size: Number(e.size || 0),
    modified: e.server_modified ? Date.parse(e.server_modified) : 0,
    etag: e.id,
  };
}

export type _Avoid = Env | DriverConfig;
