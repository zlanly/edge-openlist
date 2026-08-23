import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { sha256Hex, hmacSha256 } from "./signing";

// Bunny Storage（类 S3 / 自定义 AccessKey 头）。端点与参数均按 OpenList
// drivers/bunny_storage 移植：List=GET storageURL(dir,true)，Put=PUT storageURL，
// Remove=DELETE，下载可选 CDN 签名 URL。
export class BunnyStorageDriver extends CloudBase {
  readonly id = "bunny_storage";
  private endpoint = "storage.bunnycdn.com";
  private zone = "";
  private accessKey = "";
  private cdnBase = "";
  private cdnTokenKey = "";
  private cdnTokenMethod = "sha256";
  private cdnTokenIncludeIP = false;
  private signExpire = 4; // 小时
  private placeholder = ".openlist";
  private root = "/";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  private cfgNum(k: string, d: number): number {
    const v = (this.cfg as Record<string, unknown>)[k];
    return typeof v === "number" ? v : d;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.zone = this.cfgStr("storage_zone_name");
    this.accessKey = this.cfgStr("access_key");
    const ep = this.cfgStr("endpoint") || this.endpoint;
    this.endpoint = ep.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.cdnBase = this.cfgStr("cdn_base_url") || "";
    this.cdnTokenKey = this.cfgStr("cdn_token_key") || "";
    this.cdnTokenMethod = this.cfgStr("cdn_token_method") || "sha256";
    this.cdnTokenIncludeIP = (this.cfg as any).cdn_token_include_ip === true;
    this.signExpire = this.cfgNum("sign_url_expire", 4) || 4;
    this.placeholder = this.cfgStr("placeholder") || ".openlist";
    this.root = normalizePath(this.cfgStr("root_folder_path") || "/");
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  private objPath(path: string): string {
    const p = normalizePath(joinPath(this.root, path));
    return p.replace(/^\/+/, "");
  }

  private storageURL(path: string, dir: boolean): string {
    const clean = this.objPath(path);
    let u = `https://${this.endpoint}/${this.zone}`;
    if (clean === "" || clean === "/") {
      return u + "/";
    }
    u += "/" + clean.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
    if (dir && !u.endsWith("/")) u += "/";
    return u;
  }

  private async listRaw(path: string): Promise<any[]> {
    const url = this.storageURL(path, true);
    const r = await fetch(url, { headers: { AccessKey: this.accessKey } });
    if (!r.ok) throw new Error(`Bunny list 失败: ${r.status}`);
    const items = (await r.json()) as any[];
    return Array.isArray(items) ? items : [];
  }

  async list(path: string): Promise<FileItem[]> {
    const items = await this.listRaw(path);
    const ph = this.placeholder;
    return items
      .filter((it) => it.ObjectName && !(it.ObjectName === ph && !it.IsDirectory))
      .map((it) => ({
        name: it.ObjectName,
        path: joinPath(path, it.ObjectName),
        is_dir: !!it.IsDirectory,
        size: Number(it.Length || 0),
        modified: it.LastChanged ? Date.parse(it.LastChanged) : 0,
      }));
  }

  async get(path: string): Promise<FileItem> {
    const items = await this.listRaw(parentPath(path));
    const name = basename(path);
    const it = items.find((i) => i.ObjectName === name);
    if (!it) throw new Error("文件不存在");
    return {
      name,
      path,
      is_dir: !!it.IsDirectory,
      size: Number(it.Length || 0),
      modified: it.LastChanged ? Date.parse(it.LastChanged) : 0,
    };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const obj = this.objPath(path);
    if (this.cdnBase) {
      let cdn = this.cdnBase.replace(/\/+$/, "") + "/" + obj.replace(/^\/+/, "");
      if (this.cdnTokenKey) cdn = await this.signCDN(cdn);
      return fetch(cdn, range ? { headers: { Range: range } } : {});
    }
    const url = this.storageURL(path, false);
    const h: Record<string, string> = { AccessKey: this.accessKey };
    if (range) h["range"] = range;
    const r = await fetch(url, { headers: h });
    if (!r.ok && r.status !== 206) throw new Error(`Bunny get 失败: ${r.status}`);
    return r;
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    const url = this.storageURL(path, false);
    return { uploadUrl: url, method: "PUT", headers: { AccessKey: this.accessKey } };
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, size?: number): Promise<void> {
    const url = this.storageURL(path, false);
    const headers: Record<string, string> = {
      AccessKey: this.accessKey,
      "Content-Type": _ct || "application/octet-stream",
    };
    if (size !== undefined) headers["Content-Length"] = String(size);
    const r = await fetch(url, { method: "PUT", headers, body });
    if (!r.ok) throw new Error(`Bunny upload 失败: ${r.status}`);
  }

  async mkdir(path: string): Promise<void> {
    const url = this.storageURL(path, true) + this.placeholder;
    const r = await fetch(url, {
      method: "PUT",
      headers: { AccessKey: this.accessKey, "Content-Type": "application/octet-stream", "Content-Length": "0" },
      body: new Uint8Array(0),
    });
    if (!r.ok) throw new Error(`Bunny mkdir 失败: ${r.status}`);
  }

  async remove(path: string): Promise<void> {
    const item = await this.get(path);
    if (item.is_dir) throw new Error("Bunny 不支持目录删除");
    const url = this.storageURL(path, false);
    const r = await fetch(url, { method: "DELETE", headers: { AccessKey: this.accessKey } });
    if (!r.ok && r.status !== 404) throw new Error(`Bunny remove 失败: ${r.status}`);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.move(from, to);
  }

  async move(from: string, to: string): Promise<void> {
    const item = await this.get(from);
    if (item.is_dir) throw new Error("Bunny 不支持目录移动");
    // Bunny 无服务端 rename/copy，依源流推到目标（Worker 内流式转发，不整缓冲）。
    const src = await this.getContent(from);
    const stream: ReadableStream = typeof src === "string" ? (await fetch(src)).body! : src.body!;
    await this.putContent(to, stream, undefined, item.size);
    await this.remove(from);
  }

  private async signCDN(rawURL: string): Promise<string> {
    const u = new URL(rawURL);
    const expires = Math.floor(Date.now() / 1000) + this.signExpire * 3600;
    const sigPath = decodeURIComponent(u.pathname);
    const token = this.cdnTokenMethod.toLowerCase() === "hmac_sha256"
      ? "HS256-" + (await b64urlLocal(await hmacSha256(this.cdnTokenKey, sigPath + expires)))
      : await b64urlLocal(await sha256Hex(this.cdnTokenKey + sigPath + expires));
    u.searchParams.set("token", token);
    u.searchParams.set("expires", String(expires));
    return u.toString();
  }
}

async function b64urlLocal(buf: ArrayBuffer | string): Promise<string> {
  const b = typeof buf === "string" ? new TextEncoder().encode(buf) : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
