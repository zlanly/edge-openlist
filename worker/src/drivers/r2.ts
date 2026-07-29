import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parseRange } from "./base";

// R2 驱动：复用绑定的 R2 桶，config.prefix 作为该挂载的根目录前缀
export class R2Driver implements Driver {
  readonly id = "r2";
  private env!: Env;
  private prefix = "";

  use(env: Env): void {
    this.env = env;
  }

  async init(cfg: DriverConfig): Promise<void> {
    const p = (cfg.prefix as string) || "";
    this.prefix = p ? p.replace(/^\/+|\/+$/g, "") : "";
  }

  private key(path: string): string {
    const rel = normalizePath(path).replace(/^\//, "");
    return this.prefix ? `${this.prefix}/${rel}` : rel;
  }

  private async listAll(prefix: string): Promise<R2Object[]> {
    const out: R2Object[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.env.R2.list({ prefix, cursor });
      out.push(...r.objects);
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
    return out;
  }

  async list(path: string): Promise<FileItem[]> {
    const dir = this.key(path);
    const prefix = dir ? dir + "/" : "";
    const res = await this.env.R2.list({ prefix, delimiter: "/", limit: 1000 });
    const items: FileItem[] = [];

    for (const cp of res.delimitedPrefixes ?? []) {
      const name = cp.slice(prefix.length).replace(/\/$/, "");
      items.push({ name, path: joinPath(path, name), is_dir: true, size: 0, modified: 0 });
    }
    for (const obj of res.objects) {
      const name = obj.key.slice(prefix.length);
      if (!name) continue;
      items.push({
        name,
        path: joinPath(path, name),
        is_dir: false,
        size: obj.size,
        modified: obj.uploaded.getTime(),
        etag: obj.checksums?.md5
          ? btoa(String.fromCharCode(...new Uint8Array(obj.checksums.md5)))
          : obj.etag,
      });
    }
    return items;
  }

  async get(path: string): Promise<FileItem> {
    const obj = await this.env.R2.head(this.key(path));
    if (!obj) throw new Error("文件不存在");
    return {
      name: basename(path),
      path,
      is_dir: false,
      size: obj.size,
      modified: obj.uploaded.getTime(),
    };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const r2range = parseRange(range ?? null);
    const obj = await this.env.R2.get(this.key(path), r2range ? { range: r2range } : undefined);
    if (!obj) throw new Error("文件不存在");
    const headers = new Headers();
    headers.set("Content-Type", obj.httpMetadata?.contentType ?? "application/octet-stream");
    headers.set("Content-Length", String(obj.size));
    headers.set("ETag", obj.etag);
    if (obj.range) {
      const total = obj.size;
      const r = obj.range as any;
      headers.set("Content-Range", `bytes ${r.offset}-${r.offset + r.length - 1}/${total}`);
      return new Response(obj.body, { status: 206, headers });
    }
    return new Response(obj.body, { status: 200, headers });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    // 预签名 PUT：客户端直接写 R2，绕过 Worker 请求体限制
    const url = await (this.env.R2 as any).createPresignedUrl("PUT", this.key(path), 3600);
    return { uploadUrl: url, method: "PUT" };
  }

  async mkdir(path: string): Promise<void> {
    const key = this.key(path);
    if (!key.endsWith("/")) {
      await this.env.R2.put(key + "/", new Uint8Array(0));
    } else {
      await this.env.R2.put(key, new Uint8Array(0));
    }
  }

  async remove(path: string): Promise<void> {
    const key = this.key(path);
    const obj = await this.env.R2.head(key);
    if (obj) {
      await this.env.R2.delete(key);
      return;
    }
    // 可能是目录：删除前缀下所有对象
    const all = await this.listAll(key.endsWith("/") ? key : key + "/");
    if (all.length) {
      await this.env.R2.delete(all.map((o) => o.key));
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await this.move(from, to);
  }

  async move(from: string, to: string): Promise<void> {
    const fromKey = this.key(from);
    const toKey = this.key(to);
    const obj = await this.env.R2.get(fromKey);
    if (obj) {
      await this.env.R2.put(toKey, obj.body);
      await this.env.R2.delete(fromKey);
      return;
    }
    // 目录：整体拷贝后删除
    const all = await this.listAll(fromKey.endsWith("/") ? fromKey : fromKey + "/");
    for (const o of all) {
      const rel = o.key.slice(fromKey.length);
      const dst = (toKey.endsWith("/") ? toKey : toKey + "/") + rel;
      const src = await this.env.R2.get(o.key);
      if (src?.body) await this.env.R2.put(dst, src.body);
    }
    if (all.length) await this.env.R2.delete(all.map((o) => o.key));
  }

  // 上传完成后的落盘确认（R2 预签名已直接落盘，这里无需操作）
  async completeUpload(): Promise<void> {}
}
