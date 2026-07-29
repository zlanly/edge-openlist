// Google 相册（只读，OnlyProxy）。端点移植自 OpenList drivers/google_photo/*。
import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";

const FETCH_ALL = "all";
const FETCH_ALBUMS = "albums";
const FETCH_ROOT = "root";
const FETCH_SHARE_ALBUMS = "share_albums";
const TOKEN_URL = "https://www.googleapis.com/oauth2/v4/token";
const API = "https://photoslibrary.googleapis.com/v1";

export class GooglePhotoDriver extends CloudBase {
  readonly id = "google_photo";
  private accessToken = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  private async ensureToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    let t = await loadTokens(this.env.KV, this.mountId);
    if (isExpired(t)) {
      t = await this.refreshToken();
      await saveTokens(this.env.KV, this.mountId, t);
    }
    this.accessToken = t!.access_token;
    return this.accessToken;
  }

  private async refreshToken(): Promise<TokenSet> {
    const body = new URLSearchParams({
      client_id: this.cfgStr("client_id"),
      client_secret: this.cfgStr("client_secret"),
      refresh_token: this.cfgStr("refresh_token"),
      grant_type: "refresh_token",
    });
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!r.ok) throw new Error(`google_photo 令牌刷新失败 ${r.status}: ${await r.text().catch(() => "")}`);
    const j = (await r.json()) as any;
    if (j.error) throw new Error(`google_photo: ${j.error}`);
    return {
      access_token: j.access_token,
      expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
      extra: j,
    };
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.ensureToken()}` };
  }

  private async request<T>(url: string, method: string, query?: Record<string, string>): Promise<T> {
    let extra: Record<string, string> = { "Accept-Encoding": "gzip" };
    let j = await this.jsonReq<T>(url, method, query, extra);
    if ((j as any)?.error?.code === 401) {
      // 重新刷新并复试试一次
      const t = await this.refreshToken();
      await saveTokens(this.env.KV, this.mountId, t);
      this.accessToken = t.access_token;
      j = await this.jsonReq<T>(url, method, query, extra);
    }
    if ((j as any)?.error?.code) throw new Error(`google_photo: ${(j as any).error.message}`);
    return j;
  }

  private async jsonReq<T>(url: string, method: string, query: Record<string, string> | undefined, extra: Record<string, string>): Promise<any> {
    const u = new URL(url);
    if (query) for (const [k, v] of Object.entries(query)) if (v) u.searchParams.set(k, v);
    const r = await fetch(u.toString(), {
      method,
      headers: { ...(await this.hdrs()), ...extra },
    });
    if (!r.ok) throw new Error(`google_photo ${r.status}: ${await r.text().catch(() => "")}`);
    return (await r.json()) as T;
  }

  // 将虚拟路径映射为 OpenList 的 fetch id
  private idOf(path: string): string {
    const p = path === "/" ? [] : path.split("/").filter(Boolean);
    if (p.length === 0) return FETCH_ROOT;
    if (p.length === 1) return p[0]; // all / albums / share_albums
    return p[1]; // /albums/<id> -> <id>
  }

  private fileToObj(f: any): FileItem {
    const hasMeta = f.mediaMetadata && Object.keys(f.mediaMetadata).length > 0;
    return {
      name: hasMeta ? f.fileName : f.title,
      path: "", // 由调用方填充
      is_dir: !hasMeta,
      size: 0,
      modified: f.mediaMetadata?.creationTime ? Date.parse(f.mediaMetadata.creationTime) : 0,
      etag: f.id,
    };
  }

  private async getFiles(id: string): Promise<any[]> {
    switch (id) {
      case FETCH_ROOT:
        return [
          { id: FETCH_ALL, title: FETCH_ALL },
          { id: FETCH_ALBUMS, title: FETCH_ALBUMS },
          { id: FETCH_SHARE_ALBUMS, title: FETCH_SHARE_ALBUMS },
        ];
      case FETCH_ALBUMS:
        return this.fetchItems(`${API}/albums`, { fields: "albums(id,title,coverPhotoBaseUrl),nextPageToken", pageSize: "50", pageToken: "first" }, "GET");
      case FETCH_SHARE_ALBUMS:
        return this.fetchItems(`${API}/sharedAlbums`, { fields: "sharedAlbums(id,title,coverPhotoBaseUrl),nextPageToken", pageSize: "50", pageToken: "first" }, "GET");
      case FETCH_ALL:
        return this.fetchItems(`${API}/mediaItems`, { fields: "mediaItems(id,baseUrl,mimeType,mediaMetadata,filename),nextPageToken", pageSize: "100", pageToken: "first" }, "GET");
      default:
        return this.fetchItems(`${API}/mediaItems:search`, { fields: "mediaItems(id,baseUrl,mimeType,mediaMetadata,filename),nextPageToken", pageSize: "100", albumId: id, pageToken: "first" }, "POST");
    }
  }

  private async fetchItems(url: string, query: Record<string, string>, method: string): Promise<any[]> {
    const res: any[] = [];
    let q = { ...query };
    while (q.pageToken) {
      if (q.pageToken === "first") q.pageToken = "";
      const j = await this.request<any>(url, method, q);
      q.pageToken = j.nextPageToken || "";
      res.push(...(j.mediaItems || []), ...(j.albums || []), ...(j.sharedAlbums || []));
    }
    return res;
  }

  async list(path: string): Promise<FileItem[]> {
    const id = this.idOf(path);
    const files = await this.getFiles(id);
    return files.map((f) => {
      const o = this.fileToObj(f);
      o.path = joinPath(path, o.name || o.etag || "");
      return o;
    });
  }

  async get(path: string): Promise<FileItem> {
    const parent = parentPath(path);
    const items = await this.getFiles(this.idOf(parent));
    const o = items.find((i) => (i.fileName || i.title) === basename(path)) || items.find((i) => i.id === basename(path));
    if (!o) throw new Error("not found: " + path);
    const obj = this.fileToObj(o);
    obj.path = path;
    return obj;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const parent = parentPath(path);
    const items = await this.getFiles(this.idOf(parent));
    const o = items.find((i) => (i.fileName || i.title) === basename(path)) || items.find((i) => i.id === basename(path));
    if (!o) throw new Error("not found: " + path);
    const media: any = await this.request<any>(`${API}/mediaItems/${o.id}`, "GET", { fields: "mediaMetadata,baseUrl,mimeType" });
    let url = media.baseUrl;
    if (media.mimeType?.includes("image/")) url += "=d";
    else if (media.mimeType?.includes("video/")) url += "=dv";
    const h: Record<string, string> = {};
    if (range) h["Range"] = range;
    return fetch(url, { headers: h });
  }

  // Google 相册只读（meta.go NoUpload:true）
  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    throw new Error("Google Photo 为只读，不支持上传");
  }
  async mkdir(_path: string): Promise<void> {
    throw new Error("Google Photo 不支持创建目录");
  }
  async remove(_path: string): Promise<void> {
    throw new Error("Google Photo 不支持删除");
  }
  async rename(_from: string, _to: string): Promise<void> {
    throw new Error("Google Photo 不支持重命名");
  }
  async move(_from: string, _to: string): Promise<void> {
    throw new Error("Google Photo 不支持移动");
  }
}

export type _Avoid = Env | DriverConfig;
