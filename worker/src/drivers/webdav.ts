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

  /**
   * 拼上游 URL。
   *
   * 关键：必须逐段做百分号编码。原实现直接把原始路径塞进 URL，中文 / 空格 / #
   * / ? 之类的字符全部裸奔：
   *   · `#` 之后的部分被当成 fragment，整段路径被截断；
   *   · `?` 之后被当成 query；
   *   · 中文在部分服务端（以及 MOVE 的 Destination 头，头字段只能装 ISO-8859-1）
   *     会被按 Latin-1 解释，落地成 `æ°å»ºç®å½` 这种乱码目录。
   * 编码后 URL 全 ASCII，Destination 头也就自然合法了。
   */
  private url(path: string): string {
    const rel = normalizePath(path)
      .replace(/^\//, "")
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");
    const pre = this.prefix
      ? this.prefix.split("/").filter(Boolean).map(encodeURIComponent).join("/") + "/"
      : "";
    return `${this.endpoint}/${pre}${rel}`;
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
    // 命名空间前缀必须容忍：Nextcloud 发 <d:response>，nginx-dav / 群晖发 <D:response>，
    // 只有极少数实现发裸 <response>。原来的正则只认裸标签，接上真实服务器的结果
    // 就是「挂载成功但目录永远是空的」，用户完全无从判断哪里出了问题。
    const respRe = /<(?:[A-Za-z0-9_.-]+:)?response[\s>]([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?response>/g;
    const base = this.url(path);
    let m: RegExpExecArray | null;
    while ((m = respRe.exec(xml))) {
      const block = m[1];
      const href = (block.match(/<(?:[A-Za-z0-9_.-]+:)?href>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?href>/) || [])[1];
      if (!href) continue;
      // href 本身就是百分号编码的，先按 URL 解析再取末段解码；
      // 若先 decodeURIComponent 再喂给 URL()，文件名里的 # 和 ? 会被当成
      // fragment / query，含这些字符的文件会直接从列表里消失。
      const basePath = new URL(base).pathname.replace(/\/$/, "");
      let itemPath: string;
      try {
        itemPath = new URL(href.trim(), base).pathname.replace(/\/$/, "");
      } catch {
        continue;
      }
      if (itemPath === basePath) continue; // 跳过自身
      const isDir = /<(?:[A-Za-z0-9_.-]+:)?collection\s*\/?>/.test(block);
      let name: string;
      try {
        name = decodeURIComponent(basename(itemPath));
      } catch {
        name = basename(itemPath);
      }
      if (!name) continue;
      const size = Number((block.match(/<(?:[A-Za-z0-9_.-]+:)?getcontentlength>(\d+)/) || [])[1] || 0);
      const lm = (block.match(/<(?:[A-Za-z0-9_.-]+:)?getlastmodified>([^<]+)/) || [])[1];
      items.push({
        name,
        path: joinPath(path, name),
        is_dir: isDir,
        size,
        modified: lm ? new Date(lm).getTime() : 0,
        etag: (block.match(/<(?:[A-Za-z0-9_.-]+:)?getetag>([^<]+)/) || [])[1],
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
