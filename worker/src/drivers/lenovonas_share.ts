import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";

// Lenovo NAS share driver (port of openlist-src/drivers/lenovonas_share).
// Auth: share_id + share_pwd -> stoken (GET /access), auto-refreshed on expiry.
// Upload: NoUpload (list/get/getContent only). Endpoints verified against OpenList Go sources.
export class LenovoNasShareDriver extends CloudBase {
  readonly id = "lenovonas_share";
  private host = "https://siot-share.lenovo.com.cn";
  private stoken = "";
  private expireAt = 0;

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {
      origin: "https://siot-share.lenovo.com.cn",
      referer: "https://siot-share.lenovo.com.cn/",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) openlist-client",
      platform: "web",
      "app-version": "3",
    };
  }

  private async ensureStoken(): Promise<void> {
    if (this.stoken && this.expireAt > Date.now()) return;
    if (!this.host) this.host = "https://siot-share.lenovo.com.cn";
    const url = `${this.host}/oneproxy/api/share/v1/access?code=${encodeURIComponent(
      this.cfgStr("share_id")
    )}&password=${encodeURIComponent(this.cfgStr("share_pwd"))}`;
    const r = await fetch(url, { headers: await this.hdrs() });
    const j = (await r.json()) as any;
    if (!j.result) throw new Error(`Lenovo NAS stoken failed: ${j.error?.msg || ""}`);
    this.stoken = j.data.stoken;
    this.expireAt = Date.now() + (Number(j.data.expires_in) || 3600) * 1000 - 60000;
  }

  private async reqApi(pathname: string, params: Record<string, string>): Promise<any> {
    const qs = new URLSearchParams(params).toString();
    const r = await fetch(`${this.host}${pathname}?${qs}`, { headers: await this.hdrs() });
    const j = (await r.json()) as any;
    if (!j.result) throw new Error(`Lenovo NAS API error: ${j.error?.msg || ""}`);
    return j;
  }

  async list(path: string): Promise<FileItem[]> {
    await this.ensureStoken();
    const p = "/" + path.replace(/^\/+/, "").replace(/\/+$/, "");
    const j = await this.reqApi("/oneproxy/api/share/v1/files", {
      code: this.cfgStr("share_id"),
      num: "5000",
      stoken: this.stoken,
      path: p,
    });
    const list: any[] = (j.data && j.data.list) || [];
    return list.map((f) => {
      const isDir = f.type === "dir";
      const fp = normalizePath(f.path || joinPath(path, f.name));
      return {
        name: f.name,
        path: fp,
        is_dir: isDir,
        size: isDir ? 0 : Number(f.size) || 0,
        modified: f.chtime ? new Date(f.chtime).getTime() : f.time ? new Date(f.time).getTime() : 0,
        etag: fp,
      };
    });
  }

  async get(path: string): Promise<FileItem> {
    const parent = parentPath(path);
    const items = await this.list(parent);
    const it = items.find((i) => i.path === path);
    if (!it) throw new Error(`Lenovo NAS not found: ${path}`);
    return it;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    await this.ensureStoken();
    const j = await this.reqApi("/oneproxy/api/share/v1/file/link", {
      code: this.cfgStr("share_id"),
      stoken: this.stoken,
      path,
    });
    const dtoken = j.data?.param?.dtoken;
    if (!dtoken) throw new Error("Lenovo NAS download dtoken missing");
    const url = `${this.host}/oneproxy/api/share/v1/file/download?code=${encodeURIComponent(
      this.cfgStr("share_id")
    )}&dtoken=${encodeURIComponent(dtoken)}`;
    const headers: Record<string, string> = { Referer: "https://siot-share.lenovo.com.cn" };
    if (range) headers["Range"] = range;
    return fetch(url, { headers });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "lenovonas_share" } };
  }

  async putContent(): Promise<void> {
    throw new Error("Lenovo NAS share driver does not support upload (NoUpload)");
  }
  async mkdir(): Promise<void> {
    throw new Error("Lenovo NAS share driver does not support mkdir (NoUpload)");
  }
  async remove(): Promise<void> {
    throw new Error("Lenovo NAS share driver does not support remove (NoUpload)");
  }
  async rename(): Promise<void> {
    throw new Error("Lenovo NAS share driver does not support rename (NoUpload)");
  }
  async move(): Promise<void> {
    throw new Error("Lenovo NAS share driver does not support move (NoUpload)");
  }
}
