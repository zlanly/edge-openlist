import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { joinPath, normalizePath } from "./base";
import { CloudBase } from "./cloud-base";
import { md5Hex } from "../util/md5";

// 123 网盘分享链接（静态文本树，无远程 API）。端点/格式来自 OpenList drivers/123_link。
export class Pan123LinkDriver extends CloudBase {
  readonly id = "123_link";
  private root!: TreeNode;
  private privateKey = "";
  private uid = 0;
  private validDuration = 30;

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  private cfgNum(k: string): number {
    return Number((this.cfg as Record<string, unknown>)[k] || 0);
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.privateKey = this.cfgStr("private_key");
    this.uid = this.cfgNum("uid");
    this.validDuration = this.cfgNum("valid_duration") || 30;
    const text = this.cfgStr("origin_urls");
    this.root = buildTree(text);
    calSizeNode(this.root);
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  async list(path: string): Promise<FileItem[]> {
    const node = getByPath(this.root, path);
    if (!node || isFileNode(node)) throw new Error(`123_link: 不是目录 ${path}`);
    return node.children.map((c) => ({
      name: c.name,
      path: joinPath(path, c.name),
      is_dir: !isFileNode(c),
      size: c.size,
      modified: c.modified * 1000,
    }));
  }

  async get(path: string): Promise<FileItem> {
    const node = getByPath(this.root, path);
    if (!node) throw new Error(`123_link: 不存在 ${path}`);
    return {
      name: node.name,
      path,
      is_dir: !isFileNode(node),
      size: node.size,
      modified: node.modified * 1000,
    };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const node = getByPath(this.root, path);
    if (!node || !isFileNode(node)) throw new Error(`123_link: 不是文件 ${path}`);
    const url = signURL(node.url, this.privateKey, this.uid, this.validDuration);
    return fetch(url, range ? { headers: { Range: range } } : {});
  }

  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    throw new Error("123_link: 静态分享链接，不支持上传");
  }
  async mkdir(_path: string): Promise<void> { throw new Error("123_link: 只读"); }
  async remove(_path: string): Promise<void> { throw new Error("123_link: 只读"); }
  async rename(_from: string, _to: string): Promise<void> { throw new Error("123_link: 只读"); }
  async move(_from: string, _to: string): Promise<void> { throw new Error("123_link: 只读"); }
}

interface TreeNode {
  url: string;
  name: string;
  level: number;
  modified: number;
  size: number;
  children: TreeNode[];
}

function isFileNode(n: TreeNode): boolean {
  return n.children.length === 0;
}
function calSizeNode(n: TreeNode): void {
  if (n.children.length === 0) return;
  let total = 0;
  for (const c of n.children) {
    calSizeNode(c);
    total += c.size;
  }
  n.size = total;
}

function isFolder(line: string): boolean {
  return line.endsWith(":");
}
function parseFileLine(line: string): TreeNode {
  const idx = line.indexOf("https://");
  const i2 = line.indexOf("http://");
  let index = idx;
  if (i2 !== -1 && (index === -1 || i2 < index)) index = i2;
  if (index === -1) throw new Error(`123_link: 行缺少 URL: ${line}`);
  const url = line.slice(index);
  const info = line.slice(0, index);
  const node: TreeNode = { url, name: url.split("/").pop() || "file", level: 0, modified: Math.floor(Date.now() / 1000), size: 0, children: [] };
  if (index > 0) {
    if (!info.endsWith(":")) throw new Error(`123_link: 文件信息须以 ':' 结尾: ${line}`);
    const parts = info.slice(0, -1).split(":");
    const size = parseInt(parts[0], 10);
    if (isNaN(size)) throw new Error(`123_link: 文件大小须为整数: ${line}`);
    node.size = size;
    node.modified = parts.length > 1 ? parseInt(parts[1], 10) : Math.floor(Date.now() / 1000);
  }
  return node;
}
function buildTree(text: string): TreeNode {
  const root: TreeNode = { url: "", name: "root", level: -1, modified: 0, size: 0, children: [] };
  const stack: TreeNode[] = [root];
  for (const raw of text.split("\n")) {
    let indent = 0;
    while (indent < raw.length && raw[indent] === " ") indent++;
    if (indent % 2 !== 0) throw new Error(`123_link: 缩进非 2 倍数: ${raw}`);
    const level = indent / 2;
    const line = raw.slice(indent).trim();
    if (line === "") continue;
    while (level <= stack[stack.length - 1].level) stack.pop();
    if (isFolder(line)) {
      const node: TreeNode = { url: "", name: line.replace(/:$/, ""), level, modified: 0, size: 0, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else {
      const node = parseFileLine(line);
      node.level = level;
      stack[stack.length - 1].children.push(node);
    }
  }
  return root;
}
function splitPath(path: string): string[] {
  if (path === "/") return ["root"];
  const parts = path.split("/");
  parts[0] = "root";
  return parts;
}
function getByPath(root: TreeNode, path: string): TreeNode | null {
  return getByPathRec(root, splitPath(normalizePath(path)));
}
function getByPathRec(node: TreeNode, paths: string[]): TreeNode | null {
  if (paths.length === 0 || !node) return null;
  if (node.name !== paths[0]) return null;
  if (paths.length === 1) return node;
  for (const c of node.children) {
    const t = getByPathRec(c, paths.slice(1));
    if (t) return t;
  }
  return null;
}

function signURL(originURL: string, privateKey: string, uid: number, validDuration: number): string {
  if (!privateKey) return originURL;
  const u = new URL(originURL);
  const ts = Math.floor(Date.now() / 1000) + validDuration * 60;
  const rInt = Math.floor(Math.random() * 2 ** 31);
  const authKey = `${ts}-${rInt}-${uid}-${md5Hex(`${u.pathname}-${ts}-${rInt}-${uid}-${privateKey}`)}`;
  u.searchParams.set("auth_key", authKey);
  return u.toString();
}

export type _Avoid = Env | DriverConfig;
