import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, sortItems } from "./base";
import { CloudBase } from "./cloud-base";

// 元驱动：从一组 URL（配置 url_structure 给出）构建只读文件树，getContent 直接 fetch 对应 URL。
// 忠实移植自 OpenList url_tree（drivers/url_tree/driver.go + util.go 的 BuildTree/parseFileLine）：
//  - 文本缩进 2 空格表示层级，dir 行以 ":" 结尾；
//  - 文件行格式 [FileName:][FileSize:][Modified:]Url；name 缺省取 URL 末段；
//  - 文件夹大小为子节点之和（calSize）。
// 注：上游支持 Writable（运行时改树并写回存储），CF Worker 无持久存储，本实现为只读，写操作抛错。

interface UrlNode {
  name: string;
  url?: string;
  size: number;
  modified: number;
  level: number;
  children: UrlNode[];
}

export class UrlTreeDriver extends CloudBase {
  readonly id = "url_tree";
  private root!: UrlNode;
  private headSize = false;

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.headSize = Boolean(cfg.head_size);
    this.root = buildTree(String(cfg.url_structure || ""), this.headSize);
    calSize(this.root);
  }

  private nodeAt(path: string): UrlNode | null {
    const p = normalizePath(path);
    if (p === "/") return this.root;
    let cur = this.root;
    for (const part of p.replace(/^\//, "").split("/")) {
      const next = cur.children.find((c) => c.name === part);
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  async list(path: string): Promise<FileItem[]> {
    const node = this.nodeAt(path);
    if (!node) throw new Error("目录不存在: " + path);
    const items: FileItem[] = node.children.map((c) => ({
      name: c.name,
      path: joinPath(path, c.name),
      is_dir: c.url === undefined,
      size: c.size,
      modified: c.modified,
    }));
    return sortItems(items);
  }

  async get(path: string): Promise<FileItem> {
    const node = this.nodeAt(path);
    if (!node) throw new Error("文件不存在: " + path);
    return { name: node.name, path, is_dir: node.url === undefined, size: node.size, modified: node.modified };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const node = this.nodeAt(path);
    if (!node || node.url === undefined) throw new Error("不是文件: " + path);
    if (range) {
      const r = await fetch(node.url, { headers: { Range: range } });
      if (!r.ok && r.status !== 206) throw new Error("fetch 失败: " + r.status);
      return r;
    }
    return node.url; // 直链
  }

  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    throw new Error("url_tree 为只读驱动，不支持上传");
  }
  async putContent(_path: string, _body: ReadableStream): Promise<void> {
    throw new Error("url_tree 为只读驱动，不支持写入");
  }
  async mkdir(_path: string): Promise<void> {
    throw new Error("url_tree 为只读驱动，不支持建目录");
  }
  async remove(_path: string): Promise<void> {
    throw new Error("url_tree 为只读驱动，不支持删除");
  }
  async rename(_from: string, _to: string): Promise<void> {
    throw new Error("url_tree 为只读驱动，不支持重命名");
  }
  async move(_from: string, _to: string): Promise<void> {
    throw new Error("url_tree 为只读驱动，不支持移动");
  }
}

function splitMount(p: string): [string, string] {
  const n = normalizePath(p).replace(/^\//, "");
  const i = n.indexOf("/");
  if (i < 0) return [n, "/"];
  return [n.slice(0, i), n.slice(i)];
}

function buildTree(text: string, headSize: boolean): UrlNode {
  const root: UrlNode = { name: "root", level: -1, size: 0, modified: 0, children: [] };
  const stack: UrlNode[] = [root];
  for (const rawLine of text.split("\n")) {
    let indent = 0;
    while (indent < rawLine.length && rawLine[indent] === " ") indent++;
    if (indent % 2 !== 0) throw new Error("缩进必须是 2 的倍数: " + rawLine);
    const level = indent / 2;
    const t = rawLine.slice(indent).trim();
    if (!t) continue;
    while (level <= stack[stack.length - 1].level) stack.pop();
    if (t.endsWith(":")) {
      const node: UrlNode = { name: t.slice(0, -1), level, size: 0, modified: 0, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else {
      const node = parseFileLine(t, headSize);
      node.level = level;
      stack[stack.length - 1].children.push(node);
    }
  }
  return root;
}

function parseFileLine(line: string, headSize: boolean): UrlNode {
  const idx = line.includes("https://") ? line.indexOf("https://") : line.indexOf("http://");
  if (idx < 0) throw new Error("无效行(缺少 URL): " + line);
  const url = line.slice(idx);
  const info = line.slice(0, idx);
  const node: UrlNode = { name: "", url, size: 0, modified: 0, level: 0, children: [] };
  if (idx > 0) {
    if (!info.endsWith(":")) throw new Error("文件信息必须以 ':' 结尾: " + line);
    const info2 = info.slice(0, -1);
    if (!info2) throw new Error("文件名不能为空: " + line);
    const parts = info2.split(":");
    node.name = parts[0];
    if (parts.length > 1) {
      node.size = Number(parts[1]) || 0;
      if (parts.length > 2) node.modified = Number(parts[2]) || 0;
    }
  } else {
    node.name = url.split("/").pop() || "file";
  }
  if (node.size === 0 && headSize) {
    // 与上游一致：headSize 时通过 HEAD 取 Content-Length（可能失败，忽略）
    fetch(url, { method: "HEAD" })
      .then((r) => { const len = Number(r.headers.get("Content-Length")); if (!Number.isNaN(len)) node.size = len; })
      .catch(() => {});
  }
  return node;
}

function calSize(node: UrlNode): number {
  if (node.url !== undefined) return node.size;
  let total = 0;
  for (const c of node.children) total += calSize(c);
  node.size = total;
  return total;
}
