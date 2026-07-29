import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { buildMultipart } from "./multipart";

// Misskey 驱动（实例 API）。端点/参数按 OpenList drivers/misskey 移植：/api/drive/files、
// /api/drive/folders。导航基于 folderId，按路径遍历缓存。
export class MisskeyDriver extends CloudBase {
  readonly id = "misskey";
  private endpoint = "";
  private token = "";
  private pathToId = new Map<string, string>([["/", ""]]);

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.endpoint = (this.cfgStr("endpoint") || "https://misskey.io").replace(/\/+$/, "");
    this.token = this.cfgStr("access_token") || "";
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Authorization: this.token };
  }

  private async post(path: string, body: any): Promise<any> {
    const r = await fetch(`${this.endpoint}/api/drive${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.token },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Misskey ${path} 失败: ${r.status} ${await r.text().catch(() => "")}`);
    return r.json();
  }

  private async resolveFolderId(path: string): Promise<string> {
    const p = normalizePath(path);
    if (this.pathToId.has(p)) return this.pathToId.get(p)!;
    const segs = p.split("/").filter(Boolean);
    let cur = "/";
    let id = "";
    for (const seg of segs) {
      const folders = (await this.post("/folders", { folderId: id || undefined })) as any[];
      const f = folders.find((x) => x.name === seg);
      if (!f) throw new Error(`Misskey 路径不存在: ${path}`);
      cur = joinPath(cur, seg);
      this.pathToId.set(cur, f.id);
      id = f.id;
    }
    return id;
  }

  async list(path: string): Promise<FileItem[]> {
    const fid = await this.resolveFolderId(path);
    const [files, folders] = await Promise.all([
      this.post("/files", { folderId: fid || undefined }) as Promise<any[]>,
      this.post("/folders", { folderId: fid || undefined }) as Promise<any[]>,
    ]);
    const fItems: FileItem[] = folders.map((f) => ({
      name: f.name,
      path: joinPath(path, f.name),
      is_dir: true,
      size: 0,
      modified: f.createdAt ? Date.parse(f.createdAt) : 0,
    }));
    const items: FileItem[] = files.map((f) => ({
      name: f.name,
      path: joinPath(path, f.name),
      is_dir: false,
      size: Number(f.size || 0),
      modified: f.createdAt ? Date.parse(f.createdAt) : 0,
    }));
    return [...fItems, ...items];
  }

  async get(path: string): Promise<FileItem> {
    const items = await this.list(parentPath(path));
    const name = basename(path);
    const it = items.find((i) => i.name === name);
    if (!it) throw new Error("文件不存在");
    return it;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const id = await this.resolveFolderId(parentPath(path)).then(async (fid) => {
      const files = (await this.post("/files", { folderId: fid || undefined })) as any[];
      const f = files.find((x) => x.name === basename(path));
      if (!f) throw new Error("文件不存在");
      return f.id;
    });
    const m = (await this.post("/files/show", { fileId: id })) as any;
    return fetch(m.url, range ? { headers: { Range: range } } : {});
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "misskey" } };
  }

  async putContent(path: string, stream: ReadableStream, _ct?: string, _size = 0): Promise<void> {
    const fid = await this.resolveFolderId(parentPath(path));
    const fields: Record<string, string> = { name: basename(path), comment: "", isSensitive: "false", force: "false" };
    if (fid) fields["folderId"] = fid;
    const mp = buildMultipart(fields, { name: basename(path), stream: stream as ReadableStream<Uint8Array> });
    const r = await fetch(`${this.endpoint}/api/drive/files/create`, {
      method: "POST",
      headers: { Authorization: this.token, "Content-Type": mp.contentType },
      body: mp.body,
    });
    if (!r.ok) throw new Error(`Misskey 上传失败: ${r.status}`);
  }

  async mkdir(path: string): Promise<void> {
    const pid = await this.resolveFolderId(parentPath(path));
    await this.post("/folders/create", { parentId: pid || undefined, name: basename(path) });
  }

  async remove(path: string): Promise<void> {
    const item = await this.get(path);
    const id = await this.resolveIdLeaf(path, item.is_dir);
    if (item.is_dir) await this.post("/folders/delete", { folderId: id });
    else await this.post("/files/delete", { fileId: id });
  }

  private async resolveIdLeaf(path: string, isDir: boolean): Promise<string> {
    const fid = await this.resolveFolderId(parentPath(path));
    const arr = (await this.post(isDir ? "/folders" : "/files", { folderId: fid || undefined })) as any[];
    const f = arr.find((x) => x.name === basename(path));
    if (!f) throw new Error("文件不存在");
    return f.id;
  }

  async rename(from: string, to: string): Promise<void> {
    const item = await this.get(from);
    const id = await this.resolveIdLeaf(from, item.is_dir);
    if (item.is_dir) await this.post("/folders/update", { folderId: id, name: basename(to) });
    else await this.post("/files/update", { fileId: id, name: basename(to) });
  }

  async move(from: string, to: string): Promise<void> {
    const item = await this.get(from);
    const id = await this.resolveIdLeaf(from, item.is_dir);
    const dstFid = await this.resolveFolderId(parentPath(to));
    if (item.is_dir) await this.post("/folders/update", { folderId: id, parentId: dstFid || undefined });
    else await this.post("/files/update", { fileId: id, folderId: dstFid || undefined });
  }
}
