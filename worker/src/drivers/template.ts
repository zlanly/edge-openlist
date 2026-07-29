import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath, sortItems } from "./base";
import { CloudBase } from "./cloud-base";

// 模板/通用范本驱动：一个最小可运行的内存 Driver 骨架，可作为其它驱动的基类参考。
// 实现了 list/get/getContent/createUpload/putContent/mkdir/remove/rename/move。
// 数据保存在进程内存（非持久化），用于测试与作为新驱动开发的起点。

interface MemEntry {
  is_dir: boolean;
  size: number;
  modified: number;
  content?: Uint8Array;
}

export class TemplateDriver extends CloudBase {
  readonly id = "template";
  private store: Map<string, MemEntry> = new Map();

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    // 可选：从 cfg.seed（对象：path -> {content|is_dir}）预置内存文件
    const seed = cfg.seed;
    if (seed && typeof seed === "object") {
      for (const [p, v] of Object.entries(seed as Record<string, any>)) {
        const path = normalizePath(p);
        if (v && v.is_dir) {
          this.store.set(path, { is_dir: true, size: 0, modified: Date.now() });
        } else {
          const content = typeof v === "string" ? new TextEncoder().encode(v) : new TextEncoder().encode(String(v?.content ?? ""));
          this.store.set(path, { is_dir: false, size: content.length, modified: Date.now(), content });
        }
      }
    }
  }

  private ensureDir(path: string): void {
    const p = normalizePath(path);
    if (p !== "/" && !this.store.has(p)) this.store.set(p, { is_dir: true, size: 0, modified: Date.now() });
  }

  async list(path: string): Promise<FileItem[]> {
    const dir = normalizePath(path);
    const items: FileItem[] = [];
    for (const [k, v] of this.store) {
      if (parentPath(k) === dir && k !== dir) {
        items.push({ name: basename(k), path: k, is_dir: v.is_dir, size: v.size, modified: v.modified });
      }
    }
    return sortItems(items);
  }

  async get(path: string): Promise<FileItem> {
    const k = normalizePath(path);
    const v = this.store.get(k);
    if (!v) throw new Error("文件不存在: " + path);
    return { name: basename(k), path: k, is_dir: v.is_dir, size: v.size, modified: v.modified };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const k = normalizePath(path);
    const v = this.store.get(k);
    if (!v || v.is_dir) throw new Error("不是文件: " + path);
    const buf = v.content ?? new Uint8Array(0);
    if (range) {
      const m = range.match(/^bytes=(\d*)-(\d*)$/);
      let start = 0;
      let end = buf.length;
      if (m) {
        if (m[1]) start = Number(m[1]);
        if (m[2]) end = Number(m[2]) + 1;
      }
      const slice = buf.subarray(start, Math.min(end, buf.length));
      return new Response(slice, {
        status: 206,
        headers: { "Content-Type": "application/octet-stream", "Content-Range": `bytes ${start}-${Math.min(end, buf.length) - 1}/${buf.length}`, "Content-Length": String(slice.length) },
      });
    }
    return new Response(buf, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(buf.length) } });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "template" } };
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    this.ensureDir(parentPath(path));
    const buf = new Uint8Array(await new Response(body).arrayBuffer());
    this.store.set(normalizePath(path), { is_dir: false, size: size || buf.length, modified: Date.now(), content: buf });
  }

  async mkdir(path: string): Promise<void> {
    this.ensureDir(parentPath(path));
    this.ensureDir(path);
  }

  async remove(path: string): Promise<void> {
    const k = normalizePath(path);
    if (!this.store.has(k)) throw new Error("不存在: " + path);
    // 递归删除子树
    for (const key of [...this.store.keys()]) {
      if (key === k || key.startsWith(k + "/")) this.store.delete(key);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const f = normalizePath(from);
    const t = normalizePath(to);
    const v = this.store.get(f);
    if (!v) throw new Error("不存在: " + from);
    this.store.delete(f);
    this.store.set(t, v);
  }

  async move(from: string, to: string): Promise<void> {
    await this.rename(from, to);
  }
}
