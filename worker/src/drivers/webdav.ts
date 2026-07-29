import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath } from "./base";

// WebDAV 驱动：群晖 / Nextcloud / nginx-dav 等
export class WebDAVDriver implements Driver {
  readonly id = "webdav";
  private env!: Env;
  private endpoint = "";
  private auth = "";
  private prefix = "";

  use(env: Env): void {
    this.env = env;
  }

  async init(cfg: DriverConfig): Promise<void> {
    this.endpoint = (cfg.endpoint as string).replace(/\/$/, "");
    const u = cfg.username as string;
    const p = cfg.password as string;
    this.auth = "Basic " + btoa(`${u}:${p}`);
    const pre = (cfg.prefix as string) || "";
    this.prefix = pre ? pre.replace(/^\/+|\/+$/g, "") : "";
  }

  private url(path: string): string {
    const rel = normalizePath(path).replace(/^\//, "");
    return this.prefix ? `${this.endpoint}/${this.prefix}/${rel}` : `${this.endpoint}/${rel}`;
  }

  private davHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: this.auth, ...extra };
  }

  async list(path: string): Promise<FileItem[]> {
    const url = this.url(path) + (path === "/" ? "" : "");
    const body = `<?xml version="1.0"?><propfind xmlns="DAV:"><prop><displayname/><resourcetype/><getcontentlength/><getlastmodified/><getetag/></prop></propfind>`;
    const resp = await fetch(url, {
      method: "PROPFIND",
      headers: this.davHeaders({ Depth: "1", "Content-Type": "application/xml; charset=utf-8" }),
      body,
    });
    if (!resp.ok) throw new Error(`WebDAV PROPFIND 失败: ${resp.status}`);
    const xml = await resp.text();
    const items: FileItem[] = [];
    const respRe = /<response>([\s\S]*?)<\/response>/g;
    const base = this.url(path);
    let m: RegExpExecArray | null;
    while ((m = respRe.exec(xml))) {
      const block = m[1];
      const href = (block.match(/<href>([\s\S]*?)<\/href>/) || [])[1];
      if (!href) continue;
      const decoded = decodeURIComponent(href);
      // 按 pathname 比较（兼容 href 为完整 URL 或仅路径两种形式）
      const basePath = new URL(base).pathname.replace(/\/$/, "");
      const itemPath = new URL(decoded, base).pathname.replace(/\/$/, "");
      if (itemPath === basePath) continue; // 跳过自身
      const isDir = /<collection\s*\/?>/.test(block);
      const name = decodeURIComponent(basename(decoded.replace(/\/$/, "")));
      const size = Number((block.match(/<getcontentlength>(\d+)/) || [])[1] || 0);
      const lm = (block.match(/<getlastmodified>([^<]+)/) || [])[1];
      items.push({
        name,
        path: joinPath(path, name),
        is_dir: isDir,
        size,
        modified: lm ? new Date(lm).getTime() : 0,
        etag: (block.match(/<getetag>([^<]+)/) || [])[1],
      });
    }
    return items;
  }

  async get(path: string): Promise<FileItem> {
    const url = this.url(path);
    const resp = await fetch(url, { method: "HEAD", headers: this.davHeaders() });
    if (!resp.ok) throw new Error("文件不存在");
    return {
      name: basename(path),
      path,
      is_dir: false,
      size: Number(resp.headers.get("Content-Length") || 0),
      modified: resp.headers.get("Last-Modified") ? new Date(resp.headers.get("Last-Modified")!).getTime() : 0,
    };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const url = this.url(path);
    const headers = this.davHeaders();
    if (range) headers["Range"] = range;
    const resp = await fetch(url, { headers });
    if (!resp.ok && resp.status !== 206) throw new Error(`WebDAV GET 失败: ${resp.status}`);
    return resp;
  }

  // WebDAV 无法直接给客户端预签名，返回 worker 代理上传路径（凭据留在服务端）
  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "webdav" } };
  }

  // 由 routes/fs.ts 的 PUT 处理器调用，流式转发到上游
  async putContent(path: string, body: ReadableStream, contentType?: string, _size?: number): Promise<void> {
    const url = this.url(path);
    const headers = this.davHeaders();
    if (contentType) headers["Content-Type"] = contentType;
    const resp = await fetch(url, { method: "PUT", headers, body });
    if (!resp.ok) throw new Error(`WebDAV PUT 失败: ${resp.status}`);
  }

  async mkdir(path: string): Promise<void> {
    const resp = await fetch(this.url(path) + "/", { method: "MKCOL", headers: this.davHeaders() });
    if (!resp.ok && resp.status !== 405) throw new Error(`WebDAV MKCOL 失败: ${resp.status}`);
  }

  async remove(path: string): Promise<void> {
    const resp = await fetch(this.url(path), { method: "DELETE", headers: this.davHeaders() });
    if (!resp.ok && resp.status !== 404) throw new Error(`WebDAV DELETE 失败: ${resp.status}`);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.move(from, to);
  }

  async move(from: string, to: string): Promise<void> {
    const dest = this.url(to);
    const resp = await fetch(this.url(from), {
      method: "MOVE",
      headers: this.davHeaders({ Destination: dest, Overwrite: "T" }),
    });
    if (!resp.ok) throw new Error(`WebDAV MOVE 失败: ${resp.status}`);
  }
}
