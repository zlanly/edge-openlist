import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired } from "../util/tokenstore";
import { oauthRefresh } from "../util/oauth";

const GRAPH = "https://graph.microsoft.com/v1.0";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

// OneDrive 驱动（Microsoft Graph）
export class OneDriveDriver extends CloudBase {
  readonly id = "onedrive";
  private accessToken = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  private encodePath(p: string): string {
    return normalizePath(p).split("/").filter(Boolean).map(encodeURIComponent).join("/");
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

  private itemUrl(p: string): string {
    return p === "/" ? `${GRAPH}/me/drive/root` : `${GRAPH}/me/drive/root:${this.encodePath(p)}`;
  }

  async list(path: string): Promise<FileItem[]> {
    let next: string | undefined = path === "/" ? `${GRAPH}/me/drive/root/children` : `${GRAPH}/me/drive/root:${this.encodePath(path)}:/children`;
    const out: FileItem[] = [];
    while (next) {
      const j: { value: any[]; "@odata.nextLink"?: string } = await this.jsonGet<{ value: any[]; "@odata.nextLink"?: string }>(next);
      out.push(...(j.value || []).map((it: any) => ({
        name: it.name,
        path: joinPath(path, it.name),
        is_dir: !!it.folder,
        size: Number(it.size || 0),
        modified: it.lastModifiedDateTime ? Date.parse(it.lastModifiedDateTime) : 0,
        etag: it.etag,
      })));
      next = j["@odata.nextLink"];
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    const it = await this.jsonGet<any>(this.itemUrl(path));
    return {
      name: basename(path),
      path,
      is_dir: !!it.folder,
      size: Number(it.size || 0),
      modified: it.lastModifiedDateTime ? Date.parse(it.lastModifiedDateTime) : 0,
    };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const it = await this.jsonGet<any>(this.itemUrl(path));
    const dl = it["@microsoft.graph.downloadUrl"];
    if (!dl) throw new Error("无法获取下载链接");
    return fetch(dl, range ? { headers: { Range: range } } : {});
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    const j = await this.jsonPost<{ uploadUrl: string }>(
      `${GRAPH}/me/drive/root:${this.encodePath(path)}:/createUploadSession`,
      { "@microsoft.graph.conflictBehavior": "rename" }
    );
    return { uploadUrl: j.uploadUrl, method: "PUT" };
  }

  async mkdir(path: string): Promise<void> {
    const parent = parentPath(path);
    const url = parent === "/" ? `${GRAPH}/me/drive/root/children` : `${GRAPH}/me/drive/root:${this.encodePath(parent)}:/children`;
    await this.jsonPost(url, { name: basename(path), folder: {} });
  }

  async remove(path: string): Promise<void> {
    await this.req(this.itemUrl(path), "DELETE");
  }

  async rename(from: string, to: string): Promise<void> {
    await this.req(this.itemUrl(from), "PATCH", JSON.stringify({ name: basename(to) }), {
      "Content-Type": "application/json",
    });
  }

  private async itemId(p: string): Promise<string> {
    if (p === "/") return "root";
    const it = await this.jsonGet<any>(this.itemUrl(p));
    return it.id;
  }

  async move(from: string, to: string): Promise<void> {
    const srcId = await this.itemId(from);
    const destParentId = await this.itemId(parentPath(to));
    await this.req(`${GRAPH}/me/drive/items/${srcId}`, "PATCH", JSON.stringify({ parentReference: { id: destParentId }, name: basename(to) }), {
      "Content-Type": "application/json",
    });
  }
}

// 避免未使用告警
export type _Avoid = Env | DriverConfig;
