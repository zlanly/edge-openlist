import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { joinPath, normalizePath } from "./base";
import { CloudBase } from "./cloud-base";

// CNB（腾讯云代码）Releases。端点严格对齐 drivers/cnb_releases/{driver,util,types}.go
// 基址 https://api.cnb.cool，鉴权 Bearer；下载直链 https://cnb.cool<asset.path>
const API = "https://api.cnb.cool";

export class CnbReleasesDriver extends CloudBase {
  readonly id = "cnb_releases";
  private repo = "";
  private token = "";
  private useTagName = false;
  private defaultBranch = "main";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  private cfgBool(k: string): boolean {
    return this.cfg[k] === true || this.cfg[k] === "true";
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.repo = this.cfgStr("repo") || "";
    this.token = this.cfgStr("token") || "";
    this.useTagName = this.cfgBool("use_tag_name");
    this.defaultBranch = this.cfgStr("default_branch") || "main";
    if (!this.repo || !this.token) throw new Error("cnb_releases: 缺少 repo 或 token");
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Accept: "application/json", Authorization: `Bearer ${this.token}` };
  }

  private async reqJSON<T>(method: string, pathOrUrl: string, body?: unknown): Promise<T> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : API + pathOrUrl;
    const r = await fetch(url, {
      method,
      headers: { ...(await this.hdrs()), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    });
    if (![200, 201, 204].includes(r.status)) throw new Error(`cnb_releases ${method} ${r.status} ${url}`);
    return (await r.json().catch(() => ({} as T))) as T;
  }

  // etag 编码：目录 -> cnb:rel:<id> ；文件 -> cnb:ast:<assetId>:<releaseId>:<path>
  private encRel(id: string): string { return `cnb:rel:${id}`; }
  private encAst(assetId: string, releaseId: string, path: string): string { return `cnb:ast:${assetId}:${releaseId}:${path}`; }

  async list(path: string): Promise<FileItem[]> {
    if (normalizePath(path) === "/") {
      const rels = await this.reqJSON<any[]>("GET", `/${this.repo}/-/releases`);
      return rels.map((r) => ({
        name: this.useTagName ? r.tag_name : r.name,
        path: joinPath(path, this.useTagName ? r.tag_name : r.name),
        is_dir: true,
        size: (r.assets || []).reduce((s: number, a: any) => s + Number(a.size || 0), 0),
        modified: r.updated_at ? new Date(r.updated_at).getTime() : 0,
        etag: this.encRel(r.id),
      }));
    }
    // 子目录：发布下的资源。path 形如 /<releaseName>，需要从 etag 找 releaseId
    const items = await this.list("/");
    const dir = items.find((i) => i.path === path && i.is_dir);
    if (!dir || !dir.etag || !dir.etag.startsWith("cnb:rel:")) throw new Error("cnb_releases: 未知发布目录");
    const releaseId = dir.etag.slice("cnb:rel:".length);
    const rel = await this.reqJSON<any>("GET", `/${this.repo}/-/releases/${releaseId}`);
    return (rel.assets || []).map((a: any) => ({
      name: a.name,
      path: joinPath(path, a.name),
      is_dir: false,
      size: Number(a.size || 0),
      modified: a.updated_at ? new Date(a.updated_at).getTime() : 0,
      etag: this.encAst(a.id, releaseId, a.path),
    }));
  }

  async get(path: string): Promise<FileItem> {
    const items = await this.list(path === "/" ? "/" : parentPathOf(path));
    const hit = items.find((i) => i.path === path);
    if (!hit) throw new Error("文件不存在");
    return hit;
  }

  async getContent(_path: string, _range?: string): Promise<Response | string> {
    const items = await this.list(_path === "/" ? "/" : parentPathOf(_path));
    const hit = items.find((i) => i.path === _path);
    if (!hit || !hit.etag || !hit.etag.startsWith("cnb:ast:")) throw new Error("cnb_releases: 无法生成下载链接");
    const path = decodeURIComponent(hit.etag.split(":")[3]);
    return API.replace("api.", "") + path; // https://cnb.cool<path>
  }

  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(_path)}`, method: "PUT", headers: { "x-driver": "cnb_releases" } };
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    // 找到父发布目录 id
    const items = await this.list("/");
    const parent = items.find((i) => i.path === parentPathOf(path) && i.is_dir);
    if (!parent || !parent.etag || !parent.etag.startsWith("cnb:rel:")) throw new Error("cnb_releases: 上传需位于发布目录下");
    const releaseId = parent.etag.slice("cnb:rel:".length);
    const info = await this.reqJSON<{ upload_url: string; expires_in_sec: number; verify_url: string }>(
      "POST", `/${this.repo}/-/releases/${releaseId}/asset-upload-url`,
      { asset_name: basenameOf(path), overwrite: true, size }
    );
    const fd = new FormData();
    fd.append("file", body as any, basenameOf(path));
    const up = await fetch(info.upload_url, { method: "POST", headers: { "User-Agent": "edge-openlist" }, body: fd });
    if (up.status !== 204) throw new Error(`cnb_releases 上传失败 ${up.status}`);
    await this.reqJSON("POST", info.verify_url);
  }

  async mkdir(path: string): Promise<void> {
    if (normalizePath(path) !== "/") throw new Error("cnb_releases: 仅可在根目录创建发布");
    await this.reqJSON("POST", `/${this.repo}/-/releases`, {
      name: basenameOf(path),
      tag_name: basenameOf(path),
      target_commitish: this.defaultBranch,
    });
  }

  async remove(path: string): Promise<void> {
    const items = await this.list(path === "/" ? "/" : parentPathOf(path));
    const hit = items.find((i) => i.path === path);
    if (!hit) throw new Error("文件不存在");
    if (hit.is_dir) {
      if (!hit.etag || !hit.etag.startsWith("cnb:rel:")) throw new Error("cnb_releases: 未知发布");
      const id = hit.etag.slice("cnb:rel:".length);
      await this.reqJSON("DELETE", `/${this.repo}/-/releases/${id}`);
    } else {
      if (!hit.etag || !hit.etag.startsWith("cnb:ast:")) throw new Error("cnb_releases: 未知资源");
      const [, assetId, releaseId] = hit.etag.split(":");
      await this.reqJSON("DELETE", `/${this.repo}/-/releases/${releaseId}/assets/${assetId}`);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const items = await this.list("/");
    const dir = items.find((i) => i.path === from && i.is_dir);
    if (!dir || !dir.etag || !dir.etag.startsWith("cnb:rel:") || this.useTagName) throw new Error("cnb_releases: 仅支持重命名发布名（use_tag_name=false）");
    const id = dir.etag.slice("cnb:rel:".length);
    const url = `${API}/${this.repo}/-/releases/${id}`;
    const r = await fetch(url, {
      method: "PATCH",
      headers: { ...(await this.hdrs()), "Content-Type": "application/x-www-form-urlencoded" },
      body: `name=${encodeURIComponent(basenameOf(to))}`,
    });
    if (![200, 201, 204].includes(r.status)) throw new Error(`cnb_releases rename ${r.status}`);
  }

  async move(_from: string, _to: string): Promise<void> {
    throw new Error("NotSupport: cnb_releases 不支持移动");
  }
}

function parentPathOf(p: string): string {
  const n = normalizePath(p);
  if (n === "/") return "/";
  const i = n.lastIndexOf("/");
  return i <= 0 ? "/" : n.slice(0, i);
}
function basenameOf(p: string): string {
  const n = normalizePath(p);
  if (n === "/") return "";
  return n.slice(n.lastIndexOf("/") + 1);
}
