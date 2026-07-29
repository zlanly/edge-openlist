import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";

const API = "https://api.alipan.com";
const AUTH = "https://auth.alipan.com/v2/account/token";
const CANARY = { "X-Canary": "client=web,app=share,version=v2.3.1" };

// 阿里云盘分享链接解析（只读）。端点与参数均来自 OpenList drivers/aliyundrive_share。
export class AliyundriveShareDriver extends CloudBase {
  readonly id = "aliyundrive_share";
  private accessToken = "";
  private shareToken = "";
  private driveId = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  private async ensureToken(): Promise<void> {
    let t = await loadTokens(this.env.KV, this.mountId);
    if (isExpired(t)) {
      const rt = this.cfgStr("refresh_token") || t?.refresh_token || "";
      if (!rt) throw new Error("缺少 refresh_token");
      const r = await fetch(AUTH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: rt, grant_type: "refresh_token" }),
      });
      if (!r.ok) throw new Error(`分享令牌刷新失败 ${r.status}`);
      const j = (await r.json()) as any;
      if (j.code) throw new Error(`刷新失败: ${j.message}`);
      t = {
        access_token: j.access_token,
        refresh_token: j.refresh_token || rt,
        expires_at: Date.now() + (Number(j.expires_in) || 7200) * 1000,
        extra: j,
      };
      await saveTokens(this.env.KV, this.mountId, t);
    }
    this.accessToken = t!.access_token;
  }

  private async ensureShareToken(): Promise<void> {
    if (this.shareToken) return;
    const body: Record<string, string> = { share_id: this.cfgStr("share_id") };
    if (this.cfgStr("share_pwd")) body.share_pwd = this.cfgStr("share_pwd");
    const r = await fetch(`${API}/v2/share_link/get_share_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...CANARY },
      body: JSON.stringify(body),
    });
    const j = (await r.json()) as any;
    if (j.code) throw new Error(`获取分享令牌失败: ${j.message}`);
    this.shareToken = j.share_token;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    await this.ensureToken();
    return {
      Authorization: `Bearer\t${this.accessToken}`,
      "X-Canary": CANARY["X-Canary"],
      "x-share-token": this.shareToken,
    };
  }

  private async api(url: string, body: unknown): Promise<any> {
    await this.ensureShareToken();
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await this.hdrs()) },
      body: JSON.stringify(body),
    });
    const j = (await r.json()) as any;
    if (j.code === "AccessTokenInvalid") {
      const t = await loadTokens(this.env.KV, this.mountId);
      if (t) await saveTokens(this.env.KV, this.mountId, { ...t, access_token: "", expires_at: 0 });
      await this.ensureToken();
      return this.api(url, body);
    }
    if (j.code === "ShareLinkTokenInvalid") {
      this.shareToken = "";
      await this.ensureShareToken();
      return this.api(url, body);
    }
    if (j.code) throw new Error(`${j.code}: ${j.message}`);
    return j;
  }

  private rootId(): string {
    return this.cfgStr("root_folder_id") || "root";
  }

  // 通过逐层 list 把路径解析为 file_id
  private async resolveId(path: string): Promise<string> {
    if (path === "/" || path === "") return this.rootId();
    const parts = normalizePath(path).split("/").filter(Boolean);
    let id = this.rootId();
    for (const name of parts) {
      const data = await this.api(`${API}/adrive/v3/file/list`, {
        image_thumbnail_process: "image/resize,w_160/format,jpeg",
        image_url_process: "image/resize,w_1920/format,jpeg",
        limit: 200,
        order_by: this.cfgStr("order_by") || "name",
        order_direction: this.cfgStr("order_direction") || "ASC",
        parent_file_id: id,
        share_id: this.cfgStr("share_id"),
        video_thumbnail_process: "video/snapshot,t_1000,f_jpg,ar_auto,w_300",
        marker: "",
      });
      const item = (data.items || []).find((f: any) => f.name === name);
      if (!item) throw new Error(`路径不存在: ${path}`);
      id = item.file_id;
      if (!this.driveId && item.drive_id) this.driveId = item.drive_id;
    }
    return id;
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.resolveId(path);
    const data = await this.api(`${API}/adrive/v3/file/list`, {
      limit: 200,
      order_by: this.cfgStr("order_by") || "name",
      order_direction: this.cfgStr("order_direction") || "ASC",
      parent_file_id: id,
      share_id: this.cfgStr("share_id"),
      marker: "",
    });
    return (data.items || []).map((f: any) => ({
      name: f.name,
      path: joinPath(path, f.name),
      is_dir: f.type === "folder",
      size: Number(f.size || 0),
      modified: f.updated_at ? Date.parse(f.updated_at) : 0,
      etag: f.file_id,
    }));
  }

  async get(path: string): Promise<FileItem> {
    if (path === "/") {
      return { name: "", path: "/", is_dir: true, size: 0, modified: 0 };
    }
    const id = await this.resolveId(path);
    const data = await this.api(`${API}/adrive/v3/file/list`, {
      limit: 200,
      parent_file_id: await this.resolveId(parentPath(path)),
      share_id: this.cfgStr("share_id"),
      marker: "",
    });
    const f = (data.items || []).find((x: any) => x.file_id === id);
    if (!f) throw new Error(`文件不存在: ${path}`);
    return {
      name: f.name,
      path,
      is_dir: f.type === "folder",
      size: Number(f.size || 0),
      modified: f.updated_at ? Date.parse(f.updated_at) : 0,
      etag: f.file_id,
    };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const id = await this.resolveId(path);
    const j = await this.api(`${API}/v2/file/get_share_link_download_url`, {
      drive_id: this.driveId,
      file_id: id,
      expire_sec: 600,
      share_id: this.cfgStr("share_id"),
    });
    const url = j.download_url || j.url;
    if (!url) throw new Error("获取下载链接失败");
    return fetch(url, range ? { headers: { Range: range, Referer: "https://www.alipan.com/" } } : { headers: { Referer: "https://www.alipan.com/" } });
  }

  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    throw new Error("分享链接为只读，不支持上传");
  }

  async mkdir(_path: string): Promise<void> {
    throw new Error("分享链接为只读，不支持创建目录");
  }

  async remove(_path: string): Promise<void> {
    throw new Error("分享链接为只读，不支持删除");
  }

  async rename(_from: string, _to: string): Promise<void> {
    throw new Error("分享链接为只读，不支持重命名");
  }

  async move(_from: string, _to: string): Promise<void> {
    throw new Error("分享链接为只读，不支持移动");
  }
}

export type _Avoid = Env | DriverConfig;
