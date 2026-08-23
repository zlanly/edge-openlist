import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath, parseRange, sortItems } from "./base";
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
    this.store.set("/", { is_dir: true, size: 0, modified: Date.now() });
    // 可选：从 cfg.seed（对象：path -> {content|is_dir}）预置内存文件
    const seed = cfg.seed;
    if (seed && typeof seed === "object") {
      for (const [p, v] of Object.entries(seed as Record<string, any>)) {
        const path = normalizePath(p);
        this.ensureDir(parentPath(path));
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
    if (p === "/" || this.store.has(p)) return;
    this.ensureDir(parentPath(p));
    this.store.set(p, { is_dir: true, size: 0, modified: Date.now() });
  }

  private assertParentDir(path: string): void {
    const parent = this.store.get(parentPath(path));
    if (!parent || !parent.is_dir) throw new Error("父目录不存在: " + parentPath(path));
  }

  async list(path: string): Promise<FileItem[]> {
    const dir = normalizePath(path);
    const entry = this.store.get(dir);
    if (!entry || !entry.is_dir) throw new Error("目录不存在: " + path);
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
    const parsed = range ? parseRange(range) : null;
    if (range && !parsed) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${buf.length}` } });
    }
    let start = 0;
    let end = Math.max(0, buf.length - 1);
    if (parsed) {
      start = "suffix" in parsed ? Math.max(0, buf.length - parsed.suffix) : parsed.offset;
      end = "suffix" in parsed || parsed.length == null ? end : start + parsed.length - 1;
      if (start >= buf.length) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${buf.length}` } });
      }
      end = Math.min(end, buf.length - 1);
    }
    const body = parsed ? buf.slice(start, end + 1) : buf;
    const headers = new Headers({ "Content-Type": "application/octet-stream", "Content-Length": String(body.length) });
    if (parsed) {
      headers.set("Content-Range", `bytes ${start}-${end}/${buf.length}`);
      return new Response(body, { status: 206, headers });
    }
    return new Response(body, { headers });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "template" } };
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const normalized = normalizePath(path);
    this.assertParentDir(normalized);
    const buf = new Uint8Array(await new Response(body).arrayBuffer());
    if (size && size !== buf.length) throw new Error(`上传大小不一致：声明 ${size}，实际 ${buf.length}`);
    this.store.set(normalized, { is_dir: false, size: buf.length, modified: Date.now(), content: buf });
  }

  async mkdir(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === "/") throw new Error("不能创建根目录");
    this.assertParentDir(normalized);
    const existing = this.store.get(normalized);
    if (existing && !existing.is_dir) throw new Error("同名文件已存在: " + path);
    if (!existing) this.store.set(normalized, { is_dir: true, size: 0, modified: Date.now() });
  }

  async remove(path: string): Promise<void> {
    const k = normalizePath(path);
    if (k === "/") throw new Error("不能删除根目录");
    if (!this.store.has(k)) throw new Error("不存在: " + path);
    // 递归删除子树
    for (const key of [...this.store.keys()]) {
      if (key === k || key.startsWith(k + "/")) this.store.delete(key);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const f = normalizePath(from);
    const t = normalizePath(to);
    if (f === "/" || t === "/") throw new Error("不能重命名根目录");
    const v = this.store.get(f);
    if (!v) throw new Error("不存在: " + from);
    this.assertParentDir(t);
    if (this.store.has(t)) throw new Error("目标已存在: " + to);
    if (v.is_dir && t.startsWith(f + "/")) throw new Error("不能移动目录到自身内部");
    const entries = [...this.store.entries()].filter(([key]) => key === f || key.startsWith(f + "/"));
    for (const [key] of entries) this.store.delete(key);
    for (const [key, entry] of entries) this.store.set(t + key.slice(f.length), entry);
  }

  async move(from: string, to: string): Promise<void> {
    await this.rename(from, to);
  }
}
