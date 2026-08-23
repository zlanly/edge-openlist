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
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
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
    return `${this.base}/${encodeURIComponent(this.container)}/${encodeBlobKey(k)}`;
  }

  private keyURL(key: string): string {
    return `${this.base}/${encodeURIComponent(this.container)}/${encodeBlobKey(key)}`;
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
    if (opts.bodyLen !== undefined) headers["Content-Length"] = String(opts.bodyLen);
    if (opts.contentType) headers["Content-Type"] = opts.contentType;
    if (opts.copySource) headers["x-ms-copy-source"] = opts.copySource;
    if (opts.extra) Object.assign(headers, opts.extra);
    const msHeaders = Object.keys(headers)
      .filter((h) => h.toLowerCase().startsWith("x-ms-"))
      .sort()
      .map((h) => `${h.toLowerCase()}:${headers[h].trim()}`)
      .join("\n");
    let canonicalizedResource = `/${this.account}${u.pathname}`;
    const queryEntries = [...u.searchParams.entries()]
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [name, value] of queryEntries) canonicalizedResource += `\n${name}:${decodeURIComponent(value)}`;
    const stringToSign = [
      method,
      opts.bodyLen !== undefined && opts.bodyLen > 0 ? String(opts.bodyLen) : "",
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
    const sig = b64std(await hmacSha256(this.keyBytes, stringToSign));
    headers["Authorization"] = `SharedKey ${this.account}:${sig}`;
    return headers;
  }

  async list(path: string): Promise<FileItem[]> {
    const prefix = this.objPath(path);
    const p = prefix === "" ? "" : prefix.endsWith("/") ? prefix : prefix + "/";
    const items: FileItem[] = [];
    const seen = new Set<string>();
    let marker = "";
    do {
      const query = new URLSearchParams({ restype: "container", comp: "list", prefix: p, delimiter: "/" });
      if (marker) query.set("marker", marker);
      const url = `${this.base}/${this.container}?${query.toString()}`;
      const h = await this.sign("GET", url, { extra: { "Content-Type": "application/xml" } });
      const r = await fetch(url, { headers: h });
      if (!r.ok) throw new Error(`Azure list 失败: ${r.status}`);
      const xml = await r.text();
      const dirRe = /<BlobPrefix><Name>([^<]+)<\/Name><\/BlobPrefix>/g;
      let m: RegExpExecArray | null;
      while ((m = dirRe.exec(xml))) {
        const full = xmlUnescape(m[1]);
        const name = full.slice(p.length).replace(/\/$/, "");
        if (name && !seen.has(`d:${name}`)) {
          seen.add(`d:${name}`);
          items.push({ name, path: joinPath(path, name), is_dir: true, size: 0, modified: 0 });
        }
      }
      const blobRe = /<Blob><Name>([^<]+)<\/Name><Properties>([\s\S]*?)<\/Properties>/g;
      while ((m = blobRe.exec(xml))) {
        const full = xmlUnescape(m[1]);
        if (full.endsWith("/")) continue;
        const name = full.slice(p.length);
        if (!name || seen.has(`f:${name}`)) continue;
        const prop = m[2];
        const size = Number((prop.match(/<Content-Length>(\d+)<\/Content-Length>/) || [])[1] || 0);
        const lm = (prop.match(/<Last-Modified>([^<]+)<\/Last-Modified>/) || [])[1];
        seen.add(`f:${name}`);
        items.push({ name, path: joinPath(path, name), is_dir: false, size, modified: lm ? Date.parse(lm) : 0 });
      }
      marker = xmlUnescape((xml.match(/<NextMarker>([^<]*)<\/NextMarker>/) || [])[1] || "");
    } while (marker);
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
    return {
      uploadUrl: await this.blobSAS(blob, "w"),
      method: "PUT",
      headers: { "x-ms-blob-type": "BlockBlob" },
    };
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
    const url = this.keyURL(dir);
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
        const names: string[] = [];
      let marker = "";
      do {
        const query = new URLSearchParams({ restype: "container", comp: "list", prefix });
        if (marker) query.set("marker", marker);
        const url = `${this.base}/${this.container}?${query.toString()}`;
        const h = await this.sign("GET", url, { extra: { "Content-Type": "application/xml" } });
        const r = await fetch(url, { headers: h });
        if (!r.ok) throw new Error(`Azure list 删除目标失败: ${r.status}`);
        const xml = await r.text();
        const re = /<Blob><Name>([^<]+)<\/Name>/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(xml))) names.push(xmlUnescape(m[1]));
        marker = xmlUnescape((xml.match(/<NextMarker>([^<]*)<\/NextMarker>/) || [])[1] || "");
      } while (marker);
      for (const n of names) {
        const target = this.keyURL(n);
        const del = await this.sign("DELETE", target, { extra: { "Content-Type": "application/xml" } });
        const response = await fetch(target, { method: "DELETE", headers: del });
        if (!response.ok && response.status !== 404) throw new Error(`Azure 删除失败: ${response.status}`);
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

  private async copyBlob(src: string, dst: string): Promise<void> {
    const copyH = await this.sign("PUT", dst, {
      contentType: "application/octet-stream",
      copySource: src,
      extra: { "x-ms-blob-type": "BlockBlob" },
    });
    const cp = await fetch(dst, { method: "PUT", headers: copyH });
    if (!cp.ok) throw new Error(`Azure copy 失败: ${cp.status}`);
    if (cp.status === 202 || cp.headers.get("x-ms-copy-status") === "pending") {
      const copyId = cp.headers.get("x-ms-copy-id");
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const headH = await this.sign("HEAD", dst);
        const head = await fetch(dst, { method: "HEAD", headers: headH });
        if (!head.ok) continue;
        const status = (head.headers.get("x-ms-copy-status") || "").toLowerCase();
        const currentId = head.headers.get("x-ms-copy-id");
        if (copyId && currentId && copyId !== currentId) throw new Error("Azure copy 任务标识不一致");
        if (status === "success" || (!status && head.headers.has("Content-Length"))) return;
        if (status === "failed" || status === "aborted") throw new Error(`Azure copy 失败: ${status}`);
      }
      throw new Error("Azure copy 超时，源文件已保留");
    }
  }

  async move(from: string, to: string): Promise<void> {
    if (normalizePath(from) === normalizePath(to)) return;
    if (normalizePath(to).startsWith(normalizePath(from).replace(/\/$/, "") + "/")) {
      throw new Error("不能移动到自身或自身子目录");
    }
    const item = await this.get(from).catch(() => null);
    if (item?.is_dir) {
      const sourcePrefix = this.objPath(from).replace(/\/$/, "") + "/";
      const targetPrefix = this.objPath(to).replace(/\/$/, "") + "/";
        const names: string[] = [];
      let marker = "";
      do {
        const query = new URLSearchParams({ restype: "container", comp: "list", prefix: sourcePrefix });
        if (marker) query.set("marker", marker);
        const url = `${this.base}/${this.container}?${query.toString()}`;
        const h = await this.sign("GET", url, { extra: { "Content-Type": "application/xml" } });
        const r = await fetch(url, { headers: h });
        if (!r.ok) throw new Error(`Azure 目录列举失败: ${r.status}`);
        const xml = await r.text();
        const re = /<Blob><Name>([^<]+)<\/Name>/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(xml))) names.push(xmlUnescape(m[1]));
        marker = xmlUnescape((xml.match(/<NextMarker>([^<]*)<\/NextMarker>/) || [])[1] || "");
      } while (marker);
      if (!names.length) throw new Error("目录为空或不存在");
      for (const name of names) {
        const targetName = targetPrefix + name.slice(sourcePrefix.length);
        await this.copyBlob(this.keyURL(name), this.keyURL(targetName));
      }
      for (const name of names) {
        const url = this.keyURL(name);
        const h = await this.sign("DELETE", url, { extra: { "Content-Type": "application/xml" } });
        const r = await fetch(url, { method: "DELETE", headers: h });
        if (!r.ok && r.status !== 404) throw new Error(`Azure move 删除源文件失败: ${r.status}`);
      }
      return;
    }
    const src = this.blobURL(from);
    const dst = this.blobURL(to);
    await this.copyBlob(src, dst);
    const delH = await this.sign("DELETE", src, { extra: { "Content-Type": "application/xml" } });
    const del = await fetch(src, { method: "DELETE", headers: delH });
    if (!del.ok && del.status !== 404) throw new Error(`Azure move 删除源文件失败: ${del.status}`);
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
    const sig = b64std(await hmacSha256(this.keyBytes, sts));
    const u = new URL(`${this.base}/${this.container}/${blob}`);
    u.searchParams.set("sv", API_VER);
    u.searchParams.set("sr", "b");
    u.searchParams.set("sp", perm);
    u.searchParams.set("se", expires);
    u.searchParams.set("sig", sig);
    return u.toString();
  }
}

function xmlUnescape(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function b64std(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function encodeBlobKey(key: string): string {
  return key.split("/").map((part) => encodeURIComponent(part)).join("/");
}
