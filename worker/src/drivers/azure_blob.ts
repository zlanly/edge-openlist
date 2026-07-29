import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { hmacSha256, b64url } from "./signing";

// Azure Blob Storage（SharedKey 签名 REST）。端点/参数按 OpenList drivers/azure_blob 移植。
// 列表=GET ?restype=container&comp=list，上传=PUT blob，删除=DELETE，下载=GET（Range）。
// createUpload 返回 blob SAS 直传 URL（sp=w），无需 Worker 代理。
const API_VER = "2021-06-08";

export class AzureBlobDriver extends CloudBase {
  readonly id = "azure_blob";
  private base = "";
  private account = "";
  private container = "";
  private accessKey = "";
  private keyBytes = new Uint8Array(0);
  private signExpire = 4;
  private root = "/";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.container = (this.cfgStr("container_name") || "").trim();
    this.accessKey = this.cfgStr("access_key") || "";
    this.signExpire = Number(this.cfgStr("sign_url_expire")) || 4;
    this.root = normalizePath(this.cfgStr("root_folder_path") || "/");
    let ep = this.cfgStr("endpoint") || "";
    ep = ep.replace(/\/+$/, "");
    if (!/^https?:\/\//.test(ep)) {
      // 仅账户名
      this.account = ep.toLowerCase();
      this.base = `https://${this.account}.blob.core.windows.net`;
    } else {
      const u = new URL(ep);
      this.account = u.hostname.split(".")[0].toLowerCase();
      this.base = `${u.origin}`;
    }
    this.keyBytes = this.b64dec(this.accessKey);
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  private b64dec(s: string): Uint8Array {
    if (!s) return new Uint8Array(0);
    const bin = atob(s);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }

  private objPath(path: string): string {
    const p = normalizePath(joinPath(this.root, path));
    return p.replace(/^\/+/, "");
  }

  private blobURL(path: string): string {
    const k = this.objPath(path);
    return `${this.base}/${this.container}/${k}`;
  }

  // SharedKey 签名
  private async sign(
    method: string,
    url: string,
    opts: { bodyLen?: number; contentType?: string; extra?: Record<string, string>; copySource?: string } = {}
  ): Promise<Record<string, string>> {
    const u = new URL(url);
    const headers: Record<string, string> = {
      "x-ms-version": API_VER,
      "x-ms-date": new Date().toUTCString(),
    };
    if (opts.contentType) headers["Content-Type"] = opts.contentType;
    if (opts.copySource) headers["x-ms-copy-source"] = opts.copySource;
    if (opts.extra) Object.assign(headers, opts.extra);
    const msHeaders = Object.keys(headers)
      .filter((h) => h.toLowerCase().startsWith("x-ms-"))
      .sort()
      .map((h) => `${h.toLowerCase()}:${headers[h].trim()}`)
      .join("\n");
    const canonicalizedResource = `/${this.account}${u.pathname}`;
    const stringToSign = [
      method,
      opts.bodyLen !== undefined ? String(opts.bodyLen) : "",
      "", // content-encoding
      "", // content-language
      "", // content-md5
      opts.contentType || "",
      "", // date
      "", // if-modified-since
      "", // if-match
      "", // if-none-match
      "", // if-unmodified-since
      "", // if-range
      msHeaders,
      canonicalizedResource,
    ].join("\n");
    const sig = b64url(await hmacSha256(this.keyBytes, stringToSign));
    headers["Authorization"] = `SharedKey ${this.account}:${sig}`;
    return headers;
  }

  async list(path: string): Promise<FileItem[]> {
    const prefix = this.objPath(path);
    let p = prefix === "" ? "" : prefix.endsWith("/") ? prefix : prefix + "/";
    const url = `${this.base}/${this.container}?restype=container&comp=list&prefix=${encodeURIComponent(p)}&delimiter=/`;
    const h = await this.sign("GET", url, { extra: { "Content-Type": "application/xml" } });
    const r = await fetch(url, { headers: h });
    if (!r.ok) throw new Error(`Azure list 失败: ${r.status}`);
    const xml = await r.text();
    const items: FileItem[] = [];
    const dirRe = /<BlobPrefix><Name>([^<]+)<\/Name><\/BlobPrefix>/g;
    let m: RegExpExecArray | null;
    while ((m = dirRe.exec(xml))) {
      const name = m[1].slice(p.length).replace(/\/$/, "");
      if (name) items.push({ name, path: joinPath(path, name), is_dir: true, size: 0, modified: 0 });
    }
    const blobRe = /<Blob><Name>([^<]+)<\/Name><Properties>([\s\S]*?)<\/Properties>/g;
    while ((m = blobRe.exec(xml))) {
      const full = m[1];
      if (full.endsWith("/")) continue;
      const name = full.slice(p.length);
      if (!name) continue;
      const prop = m[2];
      const size = Number((prop.match(/<Content-Length>(\d+)<\/Content-Length>/) || [])[1] || 0);
      const lm = (prop.match(/<Last-Modified>([^<]+)<\/Last-Modified>/) || [])[1];
      items.push({ name, path: joinPath(path, name), is_dir: false, size, modified: lm ? Date.parse(lm) : 0 });
    }
    return items;
  }

  async get(path: string): Promise<FileItem> {
    const items = await this.list(parentPath(path));
    const name = basename(path);
    const it = items.find((i) => i.name === name);
    if (!it) throw new Error("文件不存在");
    return it;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const url = this.blobURL(path);
    const extra: Record<string, string> = {};
    if (range) extra["Range"] = range;
    const h = await this.sign("GET", url, { extra });
    const r = await fetch(url, { headers: h });
    if (!r.ok && r.status !== 206) throw new Error(`Azure get 失败: ${r.status}`);
    return r;
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    const blob = this.objPath(path);
    return { uploadUrl: await this.blobSAS(blob, "w"), method: "PUT" };
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const url = this.blobURL(path);
    const h = await this.sign("PUT", url, {
      bodyLen: size,
      contentType: _ct || "application/octet-stream",
      extra: { "x-ms-blob-type": "BlockBlob" },
    });
    const r = await fetch(url, { method: "PUT", headers: h, body });
    if (!r.ok) throw new Error(`Azure upload 失败: ${r.status}`);
  }

  async mkdir(path: string): Promise<void> {
    let dir = this.objPath(path);
    if (dir && !dir.endsWith("/")) dir += "/";
    const url = `${this.base}/${this.container}/${dir}`;
    const h = await this.sign("PUT", url, {
      bodyLen: 0,
      contentType: "application/octet-stream",
      extra: { "x-ms-blob-type": "BlockBlob", "x-ms-meta-hdi_isfolder": "true" },
    });
    const r = await fetch(url, { method: "PUT", headers: h, body: new Uint8Array(0) });
    if (!r.ok) throw new Error(`Azure mkdir 失败: ${r.status}`);
  }

  async remove(path: string): Promise<void> {
    const item = await this.get(path).catch(() => null);
    if (item && item.is_dir) {
      const prefix = this.objPath(path).replace(/\/$/, "") + "/";
      const url = `${this.base}/${this.container}?restype=container&comp=list&prefix=${encodeURIComponent(prefix)}`;
      const h = await this.sign("GET", url, { extra: { "Content-Type": "application/xml" } });
      const r = await fetch(url, { headers: h });
      const xml = await r.text();
      const re = /<Blob><Name>([^<]+)<\/Name>/g;
      let m: RegExpExecArray | null;
      const names: string[] = [];
      while ((m = re.exec(xml))) names.push(m[1]);
      for (const n of names) {
        const del = await this.sign("DELETE", `${this.base}/${this.container}/${n}`, { extra: { "Content-Type": "application/xml" } });
        await fetch(`${this.base}/${this.container}/${n}`, { method: "DELETE", headers: del });
      }
      return;
    }
    const url = this.blobURL(path);
    const h = await this.sign("DELETE", url, { extra: { "Content-Type": "application/xml" } });
    const r = await fetch(url, { method: "DELETE", headers: h });
    if (!r.ok && r.status !== 404) throw new Error(`Azure remove 失败: ${r.status}`);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.move(from, to);
  }

  async move(from: string, to: string): Promise<void> {
    const src = this.blobURL(from);
    const dst = this.blobURL(to);
    const copyH = await this.sign("PUT", dst, {
      contentType: "application/octet-stream",
      copySource: src,
      extra: { "x-ms-blob-type": "BlockBlob" },
    });
    const cp = await fetch(dst, { method: "PUT", headers: copyH });
    if (!cp.ok) throw new Error(`Azure copy 失败: ${cp.status}`);
    const delH = await this.sign("DELETE", src, { extra: { "Content-Type": "application/xml" } });
    await fetch(src, { method: "DELETE", headers: delH });
  }

  // blob SAS（sp=w）直传签名
  private async blobSAS(blob: string, perm: string): Promise<string> {
    const resource = `/${this.account}/${this.container}/${blob}`;
    const expires = new Date(Date.now() + this.signExpire * 3600 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
    const sts = [
      perm,
      "", // signedStart
      expires,
      resource,
      "", // signedIdentifier
      "", // signedIP
      "", // signedProtocol
      API_VER,
      "b", // signedResource
      "", // signedSnapshotTime
      "", // signedEncryptionScope
      "", "", "", "", "", // rscc rscd rsce rscl rsct
    ].join("\n");
    const sig = b64url(await hmacSha256(this.keyBytes, sts));
    const u = new URL(`${this.base}/${this.container}/${blob}`);
    u.searchParams.set("sv", API_VER);
    u.searchParams.set("sr", "b");
    u.searchParams.set("sp", perm);
    u.searchParams.set("se", expires);
    u.searchParams.set("sig", sig);
    return u.toString();
  }
}
