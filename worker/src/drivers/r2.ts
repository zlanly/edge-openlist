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
    if (!this.env.R2 || typeof (this.env.R2 as any).list !== "function") {
      throw new Error("R2 驱动需要名为 R2 的存储桶绑定");
    }
    const p = (cfg.prefix as string) || "";
    this.prefix = p ? p.replace(/^\/+|\/+$/g, "") : "";
  }

  private key(path: string): string {
    const rel = normalizePath(path).replace(/^\//, "");
    return this.prefix ? `${this.prefix}/${rel}` : rel;
  }

  private async deleteMany(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      await this.env.R2.delete(keys.slice(i, i + 1000));
    }
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
    const items: FileItem[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.env.R2.list({ prefix, delimiter: "/", limit: 1000, cursor });
      for (const cp of res.delimitedPrefixes ?? []) {
        const name = cp.slice(prefix.length).replace(/\/$/, "");
        if (name) items.push({ name, path: joinPath(path, name), is_dir: true, size: 0, modified: 0 });
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
      cursor = res.truncated ? res.cursor : undefined;
    } while (cursor);
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
    headers.set("ETag", obj.etag);
    if (obj.range) {
      const r = obj.range as any;
      headers.set("Content-Length", String(r.length));
      const head = await this.env.R2.head(this.key(path));
      const total = head?.size ?? (r.offset + r.length);
      headers.set("Content-Range", `bytes ${r.offset}-${r.offset + r.length - 1}/${total}`);
      return new Response(obj.body, { status: 206, headers });
    }
    return new Response(obj.body, { status: 200, headers });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    // Workers R2 绑定没有标准的 createPresignedUrl；通过 Worker 流式代理上传。
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "r2" } };
  }

  async putContent(path: string, body: ReadableStream, contentType?: string): Promise<void> {
    await this.env.R2.put(this.key(path), body, contentType ? { httpMetadata: { contentType } } : undefined);
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
    // 目录标记对象与其子对象可能同时存在，必须先收集两者再统一删除。
    const marker = await this.env.R2.head(key);
    const prefix = key.endsWith("/") ? key : key + "/";
    const all = await this.listAll(prefix);
    if (!marker && !all.length) throw new Error("文件或目录不存在");
    const keys = all.map((o) => o.key);
    if (marker) keys.unshift(key);
    await this.deleteMany([...new Set(keys)]);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.move(from, to);
  }

  async move(from: string, to: string): Promise<void> {
    const fromKey = this.key(from);
    const toKey = this.key(to);
    if (fromKey === toKey || toKey.startsWith(fromKey.endsWith("/") ? fromKey : fromKey + "/")) {
      throw new Error("不能移动到自身或自身子目录");
    }
    // R2 是扁平键空间，精确键和同名前缀子对象可同时存在，必须一并搬迁。
    const fromPrefix = fromKey.endsWith("/") ? fromKey : fromKey + "/";
    const toPrefix = toKey.endsWith("/") ? toKey : toKey + "/";
    const all = await this.listAll(fromPrefix);
    const exact = await this.env.R2.get(fromKey);
    if (!exact && !all.length) throw new Error("文件或目录不存在");
    if (exact) {
      await this.env.R2.put(toKey, exact.body, {
        httpMetadata: exact.httpMetadata,
        customMetadata: exact.customMetadata,
      });
    }
    for (const o of all) {
      const src = await this.env.R2.get(o.key);
      if (!src?.body) throw new Error(`移动时读取源对象失败: ${o.key}`);
      const dst = toPrefix + o.key.slice(fromPrefix.length);
      await this.env.R2.put(dst, src.body, {
        httpMetadata: src.httpMetadata,
        customMetadata: src.customMetadata,
      });
    }
    await this.deleteMany([...(exact ? [fromKey] : []), ...all.map((o) => o.key)]);
  }

  // 上传完成后的落盘确认（R2 预签名已直接落盘，这里无需操作）
  async completeUpload(): Promise<void> {}
}
