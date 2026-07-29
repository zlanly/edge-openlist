import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";

// GitHub 仓库文件驱动（API contents + git blobs/trees/commits）
// 端点严格对齐 OpenList 源码 drivers/github/{driver,util}.go
// 读取用 /repos/{owner}/{repo}/contents；写入用 git/blobs、git/trees、git/commits（流式 base64，绝不整文件缓冲）
interface GHObject {
  type: string;
  sha: string;
  name: string;
  path: string;
  size: number;
  download_url: string | null;
  entries?: GHObject[];
}

export class GitHubDriver extends CloudBase {
  readonly id = "github";
  private root = "/";
  private token = "";
  private owner = "";
  private repo = "";
  private ref = "";
  private ghProxy = "";
  private isOnBranch = false;

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.root = normalizePath(this.cfgStr("root") || "/");
    this.token = this.cfgStr("token") || "";
    this.owner = this.cfgStr("owner") || "";
    this.repo = this.cfgStr("repo") || "";
    this.ref = this.cfgStr("ref") || "";
    this.ghProxy = (this.cfgStr("gh_proxy") || "").trim();
    if (!this.owner || !this.repo) throw new Error("github: 缺少 owner 或 repo");
    if (!this.ref) {
      const r = await this.ghGetJSON<any>(`/repos/${this.owner}/${this.repo}`);
      this.ref = r.default_branch;
      this.isOnBranch = true;
    } else {
      try {
        await this.ghGetJSON<any>(`/repos/${this.owner}/${this.repo}/branches/${this.ref}`);
        this.isOnBranch = true;
      } catch {
        this.isOnBranch = false;
      }
    }
  }

  private base(): string {
    return `https://api.github.com/repos/${this.owner}/${this.repo}`;
  }
  private ghead(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...extra,
    };
    if (this.token) h.Authorization = "Bearer " + this.token;
    return h;
  }
  private async ghGetJSON<T>(api: string): Promise<T> {
    const r = await fetch(this.base() + api, { headers: this.ghead() });
    if (!r.ok) throw new Error(`github GET ${r.status} ${api}`);
    return (await r.json()) as T;
  }
  private async ghReq(method: string, api: string, body?: unknown): Promise<any> {
    const r = await fetch(this.base() + api, {
      method,
      headers: this.ghead({ "Content-Type": "application/json" }),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`github ${method} ${r.status} ${api}: ${txt}`);
    }
    return r.status === 204 ? null : await r.json();
  }

  private up(p: string): string {
    const n = normalizePath(p);
    return this.root === "/" ? n : joinPath(this.root, n);
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return this.ghead();
  }

  private async getContents(path: string): Promise<GHObject> {
    const r = await fetch(this.base() + `/contents${path}`, { headers: this.ghead({ "Accept": "application/vnd.github.object+json" }) });
    if (!r.ok) throw new Error(`github contents ${r.status} ${path}`);
    return (await r.json()) as GHObject;
  }

  async list(path: string): Promise<FileItem[]> {
    const obj = await this.getContents(this.up(path));
    if (!obj.entries) throw new Error("不是目录");
    return obj.entries
      .filter((e) => e.name !== ".gitkeep")
      .map((e) => ({
        name: e.name,
        path: joinPath(path, e.name),
        is_dir: e.type === "dir",
        size: Number(e.size || 0),
        modified: 0,
      }));
  }

  async get(path: string): Promise<FileItem> {
    const obj = await this.getContents(this.up(path));
    return {
      name: basename(path),
      path,
      is_dir: obj.type === "dir",
      size: Number(obj.size || 0),
      modified: 0,
    };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const obj = await this.getContents(this.up(path));
    if (obj.type === "submodule") throw new Error("无法下载 submodule");
    let url = obj.download_url || "";
    if (this.ghProxy && url.startsWith("https://raw.githubusercontent.com")) {
      url = url.replace("https://raw.githubusercontent.com", this.ghProxy);
    }
    return fetch(url, range ? { headers: { Range: range } } : {});
  }

  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    // 无法预签名（需 git blob/tree/commit），返回 Worker 代理上传
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(_path)}`, method: "PUT", headers: { "x-driver": "github" } };
  }

  // ---- 流式 base64 编码（不整文件缓冲）----
  private blobStream(src: ReadableStream<Uint8Array>, size: number): { stream: ReadableStream<Uint8Array>; total: number } {
    const enc = new TextEncoder();
    const head = enc.encode('{"encoding":"base64","content":"');
    const tail = enc.encode('"}');
    const total = head.length + Math.ceil(size / 3) * 4 + tail.length;
    let buf = new Uint8Array(0);
    const reader = src.getReader();
    let phase = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (phase === 0) {
          c.enqueue(head);
          phase = 1;
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          if (buf.length) c.enqueue(enc.encode(bytesToBase64(buf)));
          c.enqueue(tail);
          c.close();
          return;
        }
        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf, 0);
        merged.set(value, buf.length);
        const n = Math.floor(merged.length / 3) * 3;
        if (n > 0) c.enqueue(enc.encode(bytesToBase64(merged.subarray(0, n))));
        buf = merged.subarray(n);
      },
    });
    return { stream, total };
  }

  private async putBlob(body: ReadableStream<Uint8Array>, size: number): Promise<string> {
    const { stream, total } = this.blobStream(body, size);
    const r = await fetch(this.base() + "/git/blobs", {
      method: "POST",
      headers: this.ghead({ "Content-Type": "application/json", "Content-Length": String(total) }),
      body: stream,
    });
    if (r.status !== 201) throw new Error(`github putBlob ${r.status}`);
    const j = (await r.json()) as any;
    return j.sha as string;
  }

  private async newTree(baseSha: string, tree: any[]): Promise<string> {
    const body: any = { tree };
    if (baseSha) body.base_tree = baseSha;
    const j = await this.ghReq("POST", "/git/trees", body);
    return j.sha;
  }

  private async getTreeDirectly(path: string): Promise<{ tree: any[]; sha: string }> {
    const obj = await this.getContents(path);
    if (!obj.entries) throw new Error(`${path} 不是目录`);
    const j = await this.ghGetJSON<any>(`/git/trees/${obj.sha}`);
    return { tree: j.tree, sha: obj.sha };
  }

  // 自 path 向上直到 until，逐层替换 sha=prevSha 的节点为 curSha
  private async renewParentTrees(path: string, prevSha: string, curSha: string, until: string): Promise<string> {
    let p = path;
    let prev = prevSha;
    let cur = curSha;
    while (p !== until) {
      p = parentPath(p) === "/" ? "/" : parentPath(p);
      const t = await this.getTreeDirectly(p);
      let found: any = null;
      for (const e of t.tree) {
        if (e.sha === prev) {
          found = e;
          found.sha = cur;
          break;
        }
      }
      if (!found) throw new Error("renewParentTrees: 节点未找到");
      cur = await this.newTree(t.sha, [found]);
      prev = t.sha;
    }
    return cur;
  }

  private async commit(message: string, treeSha: string): Promise<void> {
    const head = await this.ghGetJSON<any>(`/repos/${this.owner}/${this.repo}/branches/${this.ref}`);
    const oldSha = head.commit.sha;
    const c = await this.ghReq("POST", "/git/commits", { message, tree: treeSha, parents: [oldSha] });
    await this.ghReq("PATCH", `/git/refs/heads/${this.ref}`, { sha: c.sha, force: false });
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    if (!this.isOnBranch) throw new Error("github: 非 branch 引用不可写");
    const blob = await this.putBlob(body, size);
    const parent = await this.getContents(this.up(parentPath(path)));
    const parentSha = parent.sha;
    const newSha = await this.newTree(parentSha, [{ path: basename(path), mode: "100644", type: "blob", sha: blob }]);
    const rootSha = await this.renewParentTrees(this.up(parentPath(path)), parentSha, newSha, "/");
    await this.commit(`upload ${path}`, rootSha);
  }

  async mkdir(path: string): Promise<void> {
    if (!this.isOnBranch) throw new Error("github: 非 branch 引用不可写");
    const parent = await this.getContents(this.up(parentPath(path)));
    const subSha = await this.newTree("", [{ path: ".gitkeep", mode: "100644", type: "blob", content: "" }]);
    const newSha = await this.newTree(parent.sha, [{ path: basename(path), mode: "040000", type: "tree", sha: subSha }]);
    const rootSha = await this.renewParentTrees(this.up(parentPath(path)), parent.sha, newSha, "/");
    await this.commit(`mkdir ${path}`, rootSha);
  }

  async remove(path: string): Promise<void> {
    if (!this.isOnBranch) throw new Error("github: 非 branch 引用不可写");
    const parent = await this.getContents(this.up(parentPath(path)));
    const newTree: any[] = parent.entries!.filter((e) => e.name !== basename(path)).map((e) => ({ path: e.name, mode: e.type === "dir" ? "040000" : "100644", type: e.type === "tree" ? "tree" : "blob", sha: e.sha }));
    if (newTree.length === 0) newTree.push({ path: ".gitkeep", mode: "100644", type: "blob", content: "" });
    const newSha = await this.newTree(parent.sha, newTree);
    const rootSha = await this.renewParentTrees(this.up(parentPath(path)), parent.sha, newSha, "/");
    await this.commit(`remove ${path}`, rootSha);
  }

  async rename(from: string, to: string): Promise<void> {
    if (!this.isOnBranch) throw new Error("github: 非 branch 引用不可写");
    const parent = await this.getContents(this.up(parentPath(from)));
    const newTree = parent.entries!.map((e) => {
      if (e.name === basename(from)) {
        return { path: basename(to), mode: e.type === "dir" ? "040000" : "100644", type: e.type === "tree" ? "tree" : "blob", sha: e.sha };
      }
      return { path: e.name, mode: e.type === "dir" ? "040000" : "100644", type: e.type === "tree" ? "tree" : "blob", sha: e.sha };
    });
    const newSha = await this.newTree(parent.sha, newTree);
    const rootSha = await this.renewParentTrees(this.up(parentPath(from)), parent.sha, newSha, "/");
    await this.commit(`rename ${from} -> ${to}`, rootSha);
  }

  async move(from: string, to: string): Promise<void> {
    if (!this.isOnBranch) throw new Error("github: 非 branch 引用不可写");
    const src = await this.getContents(this.up(from));
    const srcParent = await this.getContents(this.up(parentPath(from)));
    const dstParent = await this.getContents(this.up(parentPath(to)));
    // 1) 在目标父目录添加
    const dstTree = (dstParent.entries || []).map((e) => ({ path: e.name, mode: e.type === "dir" ? "040000" : "100644", type: e.type === "tree" ? "tree" : "blob", sha: e.sha }));
    dstTree.push({ path: basename(to), mode: src.type === "dir" ? "040000" : "100644", type: src.type === "tree" ? "tree" : "blob", sha: src.sha });
    const dstNewSha = await this.newTree(dstParent.sha, dstTree);
    const dstRoot = await this.renewParentTrees(this.up(parentPath(to)), dstParent.sha, dstNewSha, "/");
    await this.commit(`move ${from} -> ${to}`, dstRoot);
    // 2) 在源父目录删除
    const srcTree: any[] = (srcParent.entries || []).filter((e) => e.name !== basename(from)).map((e) => ({ path: e.name, mode: e.type === "dir" ? "040000" : "100644", type: e.type === "tree" ? "tree" : "blob", sha: e.sha }));
    if (srcTree.length === 0) srcTree.push({ path: ".gitkeep", mode: "100644", type: "blob", content: "" });
    const srcNewSha = await this.newTree(srcParent.sha, srcTree);
    const srcRoot = await this.renewParentTrees(this.up(parentPath(from)), srcParent.sha, srcNewSha, "/");
    await this.commit(`move (remove src) ${from}`, srcRoot);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}
