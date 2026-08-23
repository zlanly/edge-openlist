import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath, sortItems, parseRange } from "./base";
import { CloudBase } from "./cloud-base";

// 元/虚拟驱动：从配置内联的文件树 / 直链直接构造 FileItem，不依赖任何底层存储。
// 注：OpenList 上游 virtual 实际是“随机生成虚拟文件/随机填充内容”的压测驱动；
// 本移植按移植规范的任务说明实现为“内联配置驱动”（config.tree 描述树，支持内联 content 或 url 直链）。
// 写操作作用于内存中的树（进程级、非持久化），便于在 Worker 内做轻量虚拟挂载。

interface VNode {
  name: string;
  is_dir: boolean;
  size: number;
  modified: number;
  url?: string;
  content?: string;
  contentBytes?: Uint8Array;
  children?: Record<string, VNode>;
}

export class VirtualDriver extends CloudBase {
  readonly id = "virtual";
  private tree: VNode = { name: "", is_dir: true, size: 0, modified: Date.now(), children: {} };

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    const raw = cfg.tree;
    let parsed: any = {};
    if (typeof raw === "string") {
      try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    } else if (raw && typeof raw === "object") {
      parsed = raw;
    }
    this.tree = this.normalize(parsed, "");
  }

  private normalize(obj: any, name: string): VNode {
    if (typeof obj === "string") return { name, is_dir: false, size: 0, modified: Date.now(), url: obj };
    if (obj && typeof obj === "object" && obj.is_dir) {
      return { name, is_dir: true, size: 0, modified: Number(obj.modified) || Date.now(), children: this.normChildren(obj.children || {}) };
    }
    const isDir = !!obj && typeof obj === "object" && obj.children && !obj.url && !obj.content;
    if (isDir) return { name, is_dir: true, size: 0, modified: Number(obj.modified) || Date.now(), children: this.normChildren(obj.children || {}) };
    return {
      name,
      is_dir: false,
      size: obj?.content != null ? new TextEncoder().encode(String(obj.content)).length : Number(obj?.size) || 0,
      modified: Number(obj?.modified) || Date.now(),
      url: obj?.url,
      content: obj?.content,
    };
  }

  private normChildren(ch: any): Record<string, VNode> {
    const out: Record<string, VNode> = {};
    for (const k of Object.keys(ch || {})) out[k] = this.normalize(ch[k], k);
    return out;
  }

  private resolve(path: string): VNode | null {
    const p = normalizePath(path);
    if (p === "/") return this.tree;
    const parts = p.replace(/^\//, "").split("/");
    let cur = this.tree;
    for (const part of parts) {
      if (!cur.children || !cur.children[part]) return null;
      cur = cur.children[part];
    }
    return cur;
  }

  private parentOf(path: string): { parent: VNode; name: string } | null {
    const p = normalizePath(path);
    const name = basename(p);
    const par = this.resolve(parentPath(p));
    if (!par || !par.children) return null;
    return { parent: par, name };
  }

  async list(path: string): Promise<FileItem[]> {
    const node = this.resolve(path);
    if (!node || !node.is_dir) throw new Error("目录不存在: " + path);
    const items: FileItem[] = Object.values(node.children || {}).map((c) => ({
      name: c.name,
      path: joinPath(path, c.name),
      is_dir: c.is_dir,
      size: c.size,
      modified: c.modified,
    }));
    return sortItems(items);
  }

  async get(path: string): Promise<FileItem> {
    const node = this.resolve(path);
    if (!node) throw new Error("文件不存在: " + path);
    return { name: node.name, path, is_dir: node.is_dir, size: node.size, modified: node.modified };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const node = this.resolve(path);
    if (!node || node.is_dir) throw new Error("不是文件: " + path);
    if (node.content != null) {
      const body = node.contentBytes || new TextEncoder().encode(node.content);
      const parsed = range ? parseRange(range) : null;
      if (range && !parsed) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${body.length}` } });
      let start = 0;
      let end = Math.max(0, body.length - 1);
      if (parsed) {
        if ("suffix" in parsed) {
          start = Math.max(0, body.length - parsed.suffix);
        } else {
          start = parsed.offset;
          end = parsed.length == null ? end : start + parsed.length - 1;
        }
        if (start >= body.length) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${body.length}` } });
        end = Math.min(end, body.length - 1);
      }
      const headers = new Headers({ "Content-Type": "application/octet-stream", "Content-Length": String(end - start + 1) });
      if (parsed) {
        headers.set("Content-Range", `bytes ${start}-${end}/${body.length}`);
        return new Response(body.slice(start, end + 1), { status: 206, headers });
      }
      return new Response(body, { headers });
    }
    if (node.url) {
      if (range) {
        const r = await fetch(node.url, { headers: { Range: range } });
        if (!r.ok && r.status !== 206) throw new Error("fetch 失败: " + r.status);
        return r;
      }
      return node.url; // 直链
    }
    throw new Error("virtual 文件既无内联 content 也无 url 直链");
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "virtual" } };
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const par = this.parentOf(path);
    if (!par) throw new Error("父目录不存在");
    const name = par.name;
    const contentBytes = new Uint8Array(await new Response(body).arrayBuffer());
    par.parent.children![name] = {
      name,
      is_dir: false,
      size: contentBytes.length,
      modified: Date.now(),
      content: new TextDecoder().decode(contentBytes),
      contentBytes,
    };
  }

  async mkdir(path: string): Promise<void> {
    const par = this.parentOf(path);
    if (!par) throw new Error("父目录不存在");
    const name = par.name;
    if (!par.parent.children![name]) {
      par.parent.children![name] = { name, is_dir: true, size: 0, modified: Date.now(), children: {} };
    }
  }

  async remove(path: string): Promise<void> {
    if (normalizePath(path) === "/") throw new Error("不能删除根目录");
    const par = this.parentOf(path);
    if (!par || !par.parent.children![par.name]) throw new Error("不存在");
    delete par.parent.children![par.name];
  }

  async rename(from: string, to: string): Promise<void> {
    const source = normalizePath(from);
    const target = normalizePath(to);
    if (source === "/" || target === "/") throw new Error("不能重命名根目录");
    const par = this.parentOf(source);
    const dest = this.parentOf(target);
    if (!par || !dest || !par.parent.children![par.name]) throw new Error("路径错误");
    const node = par.parent.children![par.name];
    if (node.is_dir && target.startsWith(source + "/")) throw new Error("不能移动目录到自身内部");
    if (dest.parent.children![dest.name]) throw new Error("目标已存在");
    delete par.parent.children![par.name];
    node.name = dest.name;
    dest.parent.children![dest.name] = node;
  }

  async move(from: string, to: string): Promise<void> {
    await this.rename(from, to);
  }
}
