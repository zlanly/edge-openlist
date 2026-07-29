import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";

// Teambition（项目管理文件）。端点严格对齐 drivers/teambition/{driver,util,meta}.go
// 鉴权 Cookie；上传走 tcs.teambition.net 的 multipart 直传（非 S3 路径），再 /api/works 登记
interface Collection { _id: string; title: string; updated: string; }
interface Work { _id: string; fileName: string; fileSize: number; downloadUrl: string; updated: string; thumbnail?: string; }

export class TeambitionDriver extends CloudBase {
  readonly id = "teambition";
  private region = "china";
  private cookie = "";
  private projectId = "";
  private rootId = "";
  private orderBy = "fileName";
  private orderDir = "Asc";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.region = this.cfgStr("region") || "china";
    this.cookie = this.cfgStr("cookie") || "";
    this.projectId = this.cfgStr("project_id") || "";
    this.rootId = this.cfgStr("root") || "";
    this.orderBy = this.cfgStr("order_by") || "fileName";
    this.orderDir = this.cfgStr("order_direction") || "Asc";
    if (!this.cookie || !this.projectId) throw new Error("teambition: 缺少 cookie 或 project_id");
  }

  private host(): string {
    return this.region === "international" ? "https://us.teambition.com" : "https://www.teambition.com";
  }
  private tcsHost(): string {
    return this.region === "international" ? "https://us-tcs.teambition.net" : "https://tcs.teambition.net";
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Cookie: this.cookie };
  }

  private async tbGet<T>(path: string): Promise<T> {
    const r = await fetch(this.host() + path, { headers: { Cookie: this.cookie } });
    if (!r.ok) throw new Error(`teambition GET ${r.status} ${path}`);
    const j = (await r.json()) as any;
    if (j && j.name) throw new Error(`teambition: ${j.message}`);
    return j as T;
  }
  private async tbReq(method: string, path: string, body?: unknown): Promise<any> {
    const r = await fetch(this.host() + path, {
      method,
      headers: { Cookie: this.cookie, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`teambition ${method} ${r.status} ${path}`);
    const j = (await r.json().catch(() => null)) as any;
    if (j && j.name) throw new Error(`teambition: ${j.message}`);
    return j;
  }

  private async getCollections(parentId: string): Promise<Collection[]> {
    const out: Collection[] = [];
    for (let page = 1; ; page++) {
      const cols = await this.tbGet<Collection[]>(`/api/collections?_parentId=${encodeURIComponent(parentId)}&_projectId=${encodeURIComponent(this.projectId)}&order=${this.orderBy + this.orderDir}&count=50&page=${page}`);
      if (!cols.length) break;
      out.push(...cols.filter((c) => c.title));
    }
    return out;
  }
  private async getWorks(parentId: string): Promise<Work[]> {
    const out: Work[] = [];
    for (let page = 1; ; page++) {
      const ws = await this.tbGet<Work[]>(`/api/works?_parentId=${encodeURIComponent(parentId)}&_projectId=${encodeURIComponent(this.projectId)}&order=${this.orderBy + this.orderDir}&count=50&page=${page}`);
      if (!ws.length) break;
      out.push(...ws);
    }
    return out;
  }

  // 解析虚拟路径对应的 collection id（逐层在集合里查找）
  private async resolveCollectionId(path: string): Promise<string> {
    if (normalizePath(path) === "/") return this.rootId;
    let pid = this.rootId;
    const segs = normalizePath(path).split("/").filter(Boolean);
    for (const seg of segs) {
      const cols = await this.getCollections(pid);
      const hit = cols.find((c) => c.title === seg);
      if (!hit) throw new Error(`teambition: 目录不存在 ${path}`);
      pid = hit._id;
    }
    return pid;
  }

  async list(path: string): Promise<FileItem[]> {
    const pid = await this.resolveCollectionId(path === "/" ? "/" : path);
    const cols = await this.getCollections(pid);
    const works = await this.getWorks(pid);
    const items: FileItem[] = cols.map((c) => ({
      name: c.title, path: joinPath(path, c.title), is_dir: true,
      size: 0, modified: c.updated ? new Date(c.updated).getTime() : 0, etag: c._id,
    }));
    for (const w of works) {
      items.push({
        name: w.fileName, path: joinPath(path, w.fileName), is_dir: false,
        size: Number(w.fileSize || 0), modified: w.updated ? new Date(w.updated).getTime() : 0, etag: w._id,
      });
    }
    return items;
  }

  async get(path: string): Promise<FileItem> {
    const pid = await this.resolveCollectionId(parentPath(path));
    const cols = await this.getCollections(pid);
    const c = cols.find((x) => x.title === basename(path));
    if (c) return { name: c.title, path, is_dir: true, size: 0, modified: c.updated ? new Date(c.updated).getTime() : 0, etag: c._id };
    const works = await this.getWorks(pid);
    const w = works.find((x) => x.fileName === basename(path));
    if (!w) throw new Error("文件不存在");
    return { name: w.fileName, path, is_dir: false, size: Number(w.fileSize || 0), modified: w.updated ? new Date(w.updated).getTime() : 0, etag: w._id };
  }

  async getContent(path: string, _range?: string): Promise<Response | string> {
    const pid = await this.resolveCollectionId(parentPath(path));
    const works = await this.getWorks(pid);
    const w = works.find((x) => x.fileName === basename(path));
    if (!w || !w.downloadUrl) throw new Error("无法生成下载链接");
    // 跟随 302 获取真实直链（与 OpenList Link 一致）
    const r = await fetch(w.downloadUrl, { redirect: "manual" });
    if (r.status === 302 && r.headers.get("location")) return r.headers.get("location") as string;
    return w.downloadUrl;
  }

  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(_path)}`, method: "PUT", headers: { "x-driver": "teambition" } };
  }

  async putContent(path: string, body: ReadableStream, contentType?: string, size = 0): Promise<void> {
    const pid = await this.resolveCollectionId(parentPath(path));
    // 取上传 token
    let token = "";
    if (this.region === "international") {
      const html = await (await fetch(this.host() + "/projects", { headers: { Cookie: this.cookie } })).text();
      token = between(html, "strikerAuth&quot;:&quot;", "&quot;,&quot;phoneForLogin");
    } else {
      const me = await this.tbGet<any>("/api/v2/users/me");
      token = me.strikerAuth || "";
    }
    if (!token) throw new Error("teambition: 获取上传 token 失败");
    // multipart 上传到 tcs
    const fd = new FormData();
    fd.append("name", basename(path));
    fd.append("type", contentType || "application/octet-stream");
    fd.append("size", String(size));
    fd.append("lastModifiedDate", new Date().toUTCString());
    fd.append("file", body as any, basename(path));
    const up = await fetch(this.tcsHost() + "/upload", {
      method: "POST",
      headers: { Authorization: token },
      body: fd,
    });
    if (!up.ok) throw new Error(`teambition 上传 ${up.status}`);
    const file = (await up.json()) as any;
    // 登记到项目
    await this.tbReq("POST", "/api/works", {
      works: [{ ...file, involveMembers: [], visible: "members", _parentId: pid }],
      _parentId: pid,
    });
  }

  async mkdir(path: string): Promise<void> {
    const pid = await this.resolveCollectionId(parentPath(path));
    await this.tbReq("POST", "/api/collections", {
      objectType: "collection", _projectId: this.projectId, title: basename(path),
      color: "blue", _parentId: pid, subCount: null, recentWorks: [],
    });
  }

  async remove(path: string): Promise<void> {
    const item = await this.get(path);
    const pre = item.is_dir ? "/api/collections/" : "/api/works/";
    await this.tbReq("POST", pre + item.etag + "/archive");
  }

  async rename(from: string, to: string): Promise<void> {
    const item = await this.get(from);
    if (item.is_dir) {
      await this.tbReq("PUT", "/api/collections/" + item.etag, { title: basename(to) });
    } else {
      await this.tbReq("PUT", "/api/works/" + item.etag, { fileName: basename(to) });
    }
  }

  async move(from: string, to: string): Promise<void> {
    const item = await this.get(from);
    const dstPid = await this.resolveCollectionId(parentPath(to));
    const pre = item.is_dir ? "/api/collections/" : "/api/works/";
    await this.tbReq("PUT", pre + item.etag + "/move", { _parentId: dstPid });
  }
}

function between(str: string, start: string, end: string): string {
  const n = str.indexOf(start);
  if (n === -1) return "";
  const s = str.slice(n + start.length);
  const m = s.indexOf(end);
  if (m === -1) return "";
  return s.slice(0, m);
}
