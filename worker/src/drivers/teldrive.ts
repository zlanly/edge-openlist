import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";

// TelDrive（Telegram 驱动）。端点严格对齐 drivers/teldrive/{driver,upload,util}.go
// 鉴权 Cookie（access_token=xxx）。列表/读取走 /api/files；上传为分片直传到 /api/uploads/{id} 后登记 /api/files
interface TlObj { id: string; name: string; type: string; size: number; updatedAt: string; }
interface FilePart { id: string; salt: string; name: string; partNo: number; }

export class TeldriveDriver extends CloudBase {
  readonly id = "teldrive";
  private address = "";
  private cookie = "";
  private useShareLink = false;
  private chunkSize = 10; // MiB
  private uploadConcurrency = 4;

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  private cfgNum(k: string, d: number): number {
    const v = Number(this.cfg[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  }
  private cfgBool(k: string): boolean {
    return this.cfg[k] === true || this.cfg[k] === "true";
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.address = (this.cfgStr("url") || "").replace(/\/$/, "");
    this.cookie = this.cfgStr("cookie") || "";
    this.useShareLink = this.cfgBool("use_share_link");
    this.chunkSize = this.cfgNum("chunk_size", 10);
    this.uploadConcurrency = this.cfgNum("upload_concurrency", 4);
    if (!this.cookie.startsWith("access_token=")) throw new Error("teldrive: cookie 必须以 access_token= 开头");
    if (!this.address) throw new Error("teldrive: 缺少 url");
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Cookie: this.cookie };
  }

  private async tReq<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(this.address + path, {
      method,
      headers: { Cookie: this.cookie, ...(body && method !== "GET" ? { "Content-Type": "application/json" } : {}) },
      body: body && method !== "GET" ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`teldrive ${method} ${r.status} ${path}: ${txt}`);
    }
    return (await r.json().catch(() => ({} as T))) as T;
  }

  private toItem(it: TlObj, basePath: string): FileItem {
    return {
      name: it.name,
      path: joinPath(basePath, it.name),
      is_dir: it.type === "folder",
      size: Number(it.size || 0),
      modified: it.updatedAt ? new Date(it.updatedAt).getTime() : 0,
      etag: it.id,
    };
  }

  async list(path: string): Promise<FileItem[]> {
    const out: FileItem[] = [];
    let page = 1;
    for (;;) {
      const j = await this.tReq<{ items: TlObj[]; meta: { totalPages: number } }>(
        "GET", `/api/files?path=${encodeURIComponent(normalizePath(path))}&limit=500&page=${page}`
      );
      for (const it of j.items || []) out.push(this.toItem(it, path));
      if (!j.items || j.items.length === 0 || page >= (j.meta?.totalPages || 1)) break;
      page++;
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    if (normalizePath(path) === "/") return { name: "", path: "/", is_dir: true, size: 0, modified: 0 };
    const parent = parentPath(path);
    const j = await this.tReq<{ items: TlObj[] }>(
      "GET", `/api/files?path=${encodeURIComponent(normalizePath(parent))}&name=${encodeURIComponent(basename(path))}&type=any&operation=find`
    );
    const it = j.items?.[0];
    if (!it) throw new Error("文件不存在");
    return this.toItem(it, parent);
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const item = await this.get(path);
    let url: string;
    if (this.useShareLink) {
      // 创建/获取分享链接（302 直链）
      const share = await this.tReq<any>("POST", `/api/files/${item.etag}/share`, { expiresAt: new Date(Date.now() + 3600_000).toISOString() }).catch(() => null);
      const id = share?.id || (await this.tReq<any>("GET", `/api/files/${item.etag}/share`)).id;
      url = `${this.address}/api/shares/${encodeURIComponent(String(id))}/files/${encodeURIComponent(item.etag || "")}/${encodeURIComponent(basename(path))}`;
    } else {
      url = `${this.address}/api/files/${encodeURIComponent(item.etag || "")}/${encodeURIComponent(basename(path))}`;
    }
    const headers: Record<string, string> = { Cookie: this.cookie };
    if (range) headers.Range = range;
    return fetch(url, { headers });
  }

  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(_path)}`, method: "PUT", headers: { "x-driver": "teldrive" } };
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const name = basename(path);
    const parent = normalizePath(parentPath(path));
    const fileId = crypto.randomUUID();
    // 初始化上传任务
    await this.tReq("GET", `/api/uploads/${fileId}`).catch(() => {});
    if (size === 0) {
      await this.tReq("POST", "/api/files", { name, type: "file", path: parent });
      return;
    }
    const chunkBytes = this.chunkSize * 1024 * 1024;
    const totalParts = Math.max(1, Math.ceil(size / chunkBytes));
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    let leftover = new Uint8Array(0);
    const parts: FilePart[] = [];
    let uploaded = 0;
    for (let partNo = 1; partNo <= totalParts; partNo++) {
      const cur = Math.min(chunkBytes, size - uploaded);
      while (leftover.length < cur) {
        const { done, value } = await reader.read();
        if (done) break;
        const m = new Uint8Array(leftover.length + value.length);
        m.set(leftover, 0);
        m.set(value, leftover.length);
        leftover = m;
      }
      const part = leftover.subarray(0, cur);
      const rest = leftover.subarray(cur);
      leftover = new Uint8Array(rest);
      const partName = crypto.randomUUID();
      const fp = await this.uploadPart(fileId, partNo, name, partName, part);
      parts.push(fp);
      uploaded += cur;
    }
    // 登记文件
    await this.tReq("POST", "/api/files", {
      name, type: "file", path: parent,
      parts: parts.map((p) => ({ id: p.id, salt: p.salt })),
      size,
    });
    await this.tReq("DELETE", `/api/uploads/${fileId}`).catch(() => {});
  }

  private async uploadPart(fileId: string, partNo: number, fileName: string, partName: string, data: Uint8Array): Promise<FilePart> {
    const url = `${this.address}/api/uploads/${fileId}?partName=${encodeURIComponent(partName)}&partNo=${partNo}&fileName=${encodeURIComponent(fileName)}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { Cookie: this.cookie, "Content-Type": "application/octet-stream", "Content-Length": String(data.length) },
      body: data,
    });
    if (!r.ok) throw new Error(`teldrive 分片上传 ${r.status}`);
    return (await r.json()) as FilePart;
  }

  async mkdir(path: string): Promise<void> {
    await this.tReq("POST", "/api/files/mkdir", { path: normalizePath(path) });
  }

  async remove(path: string): Promise<void> {
    const item = await this.get(path);
    await this.tReq("POST", "/api/files/delete", { ids: [item.etag] });
  }

  async rename(from: string, to: string): Promise<void> {
    const item = await this.get(from);
    await this.tReq("PATCH", `/api/files/${item.etag}`, { name: basename(to) });
  }

  async move(from: string, to: string): Promise<void> {
    const item = await this.get(from);
    const dst = await this.get(to === "/" ? "/" : parentPath(to));
    await this.tReq("POST", "/api/files/move", { ids: [item.etag], destinationParent: dst.etag });
  }
}
