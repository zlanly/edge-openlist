import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired } from "../util/tokenstore";
import { oauthRefresh } from "../util/oauth";

const API = "https://www.googleapis.com";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FOLDER_MIME = "application/vnd.google-apps.folder";
// 「添加到我的云端硬盘」产生的共享条目实际是快捷方式：本体没有内容，
// 直接下载会拿到一个 HTML 存根。必须取 shortcutDetails 解析到真实目标。
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

// Google Drive 驱动（Drive API v3）
export class GoogleDriveDriver extends CloudBase {
  readonly id = "googledrive";
  private accessToken = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  private async ensureToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    let t = await loadTokens(this.env.KV, this.mountId);
    if (isExpired(t)) {
      const rt = this.cfgStr("refreshToken") || t?.refresh_token || "";
      if (!rt) throw new Error("缺少 refresh_token，请先完成 OAuth 授权绑定");
      t = await oauthRefresh(TOKEN_URL, this.cfgStr("clientId"), this.cfgStr("clientSecret"), rt);
      await saveTokens(this.env.KV, this.mountId, t);
    }
    this.accessToken = t!.access_token;
    return this.accessToken;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.ensureToken()}` };
  }

  // 把挂载内路径解析为 Drive 文件 ID（逐段遍历）
  private async resolveId(path: string): Promise<string> {
    if (path === "/" || path === "") return "root";
    const token = await this.ensureToken();
    let parent = "root";
    const segs = path.split("/").filter(Boolean);
    for (const seg of segs) {
      const q = `'${parent}' in parents and name = ${JSON.stringify(seg)} and trashed = false`;
      const url = `${API}/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,mimeType,shortcutDetails)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`;
      const j = await this.jsonGet<{ files: any[] }>(url);
      const f = j.files?.[0];
      if (!f) throw new Error(`路径不存在: ${path}`);
      // 快捷方式：解析到目标 ID，否则后续列表/下载都会作用在快捷方式存根上
      parent = f.mimeType === SHORTCUT_MIME && f.shortcutDetails?.targetId ? f.shortcutDetails.targetId : f.id;
    }
    return parent;
  }

  async list(path: string): Promise<FileItem[]> {
    const parentId = await this.resolveId(path);
    const q = `'${parentId}' in parents and trashed = false`;
    const out: FileItem[] = [];
    let pageToken = "";
    for (;;) {
      const params = new URLSearchParams({ q, fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,shortcutDetails)", pageSize: "1000", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
      if (pageToken) params.set("pageToken", pageToken);
      const j = await this.jsonGet<{ files: any[]; nextPageToken?: string }>(`${API}/drive/v3/files?${params}`);
      out.push(...(j.files || []).map((f) => {
        const isShortcut = f.mimeType === SHORTCUT_MIME;
        // 快捷方式按目标定性：指向文件夹就当目录展示，点进去列的是目标内容
        const mime = isShortcut ? f.shortcutDetails?.targetMimeType || "" : f.mimeType;
        return {
          name: f.name,
          path: joinPath(path, f.name),
          is_dir: mime === FOLDER_MIME,
          size: Number(f.size || 0),
          modified: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
          etag: (isShortcut && f.shortcutDetails?.targetId) || f.id,
        };
      }));
      if (!j.nextPageToken || j.nextPageToken === pageToken) break;
      pageToken = j.nextPageToken;
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    const id = await this.resolveId(path);
    const f = await this.jsonGet<any>(`${API}/drive/v3/files/${id}?fields=id,name,mimeType,size,modifiedTime&supportsAllDrives=true`);
    return {
      name: f.name,
      path,
      is_dir: f.mimeType === FOLDER_MIME,
      size: Number(f.size || 0),
      modified: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
    };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const id = await this.resolveId(path);
    const url = `${API}/drive/v3/files/${id}?alt=media&supportsAllDrives=true`;
    const h: Record<string, string> = { Authorization: `Bearer ${await this.ensureToken()}` };
    if (range) h["Range"] = range;
    const r = await fetch(url, { headers: h });
    if (!r.ok && r.status !== 206) throw new Error(`下载失败 ${r.status}`);
    return r;
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    const parentId = await this.resolveId(parentPath(path));
    const token = await this.ensureToken();
    const r = await fetch(`${UPLOAD}?uploadType=resumable&supportsAllDrives=true`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: basename(path), parents: [parentId], mimeType: "application/octet-stream" }),
    });
    if (!r.ok) throw new Error(`创建上传会话失败 ${r.status}`);
    const uploadUrl = r.headers.get("Location");
    if (!uploadUrl) throw new Error("无法获取上传会话 URL");
    return { uploadUrl, method: "PUT" };
  }

  async mkdir(path: string): Promise<void> {
    const parentId = await this.resolveId(parentPath(path));
    await this.jsonPost(`${API}/drive/v3/files?supportsAllDrives=true`, {
      name: basename(path),
      mimeType: FOLDER_MIME,
      parents: [parentId],
    });
  }

  async remove(path: string): Promise<void> {
    const id = await this.resolveId(path);
    await this.req(`${API}/drive/v3/files/${id}?supportsAllDrives=true`, "DELETE");
  }

  async rename(from: string, to: string): Promise<void> {
    const id = await this.resolveId(from);
    await this.req(`${API}/drive/v3/files/${id}?supportsAllDrives=true`, "PATCH", JSON.stringify({ name: basename(to) }), {
      "Content-Type": "application/json",
    });
  }

  async move(from: string, to: string): Promise<void> {
    const id = await this.resolveId(from);
    const destId = await this.resolveId(parentPath(to));
    await this.req(`${API}/drive/v3/files/${id}?supportsAllDrives=true`, "PATCH", JSON.stringify({ parents: [destId] }), {
      "Content-Type": "application/json",
    });
  }
}

export type _Avoid = Env | DriverConfig;
