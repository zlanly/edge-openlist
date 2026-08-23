import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";
import { md5Hex, sha1Hex } from "../util/md5";

const API = "https://open-api.123pan.com";

// 123 开放平台（ClientID/ClientSecret 或 refresh_token 在线刷新）。端点来自 OpenList drivers/123_open。
export class Open123Driver extends CloudBase {
  readonly id = "123_open";
  private accessToken = "";
  private expiredAt = 0;
  private uid = 0;

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  private async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiredAt - 5 * 60 * 1000) return this.accessToken;
    let t = await loadTokens(this.env.KV, this.mountId);
    if (!isExpired(t)) {
      this.accessToken = t!.access_token;
      this.expiredAt = t!.expires_at;
      return this.accessToken;
    }
    // 1) 在线 API 刷新
    const rt = this.cfgStr("RefreshToken");
    const apiAddr = this.cfgStr("api_url_address") || "https://api.oplist.org/123cloud/renewapi";
    if (rt && apiAddr) {
      const r = await fetch(`${apiAddr}?refresh_ui=${encodeURIComponent(rt)}&server_use=true&driver_txt=123cloud_oa`);
      if (r.ok) {
        const j = (await r.json()) as any;
        if (j.access_token) {
          this.accessToken = j.access_token;
          this.expiredAt = Date.now() + (Number(j.expires_in) || 86400) * 1000;
          await saveTokens(this.env.KV, this.mountId, { access_token: this.accessToken, refresh_token: j.refresh_token || rt, expires_at: this.expiredAt });
          return this.accessToken;
        }
      }
    }
    // 2) ClientID/ClientSecret 客户端凭证
    const cid = this.cfgStr("ClientID");
    const csec = this.cfgStr("ClientSecret");
    if (cid && csec) {
      const r = await fetch(`${API}/api/v1/access_token`, {
        method: "POST",
        headers: { platform: "open_platform", "Content-Type": "application/json" },
        body: JSON.stringify({ clientID: cid, clientSecret: csec }),
      });
      const j = (await r.json()) as any;
      if (j.code !== 0 || !j.data?.accessToken) throw new Error(`123_open: 获取令牌失败 ${j.message}`);
      this.accessToken = j.data.accessToken;
      this.expiredAt = Date.parse(j.data.expiredAt);
      await saveTokens(this.env.KV, this.mountId, { access_token: this.accessToken, expires_at: this.expiredAt });
      return this.accessToken;
    }
    if (this.cfgStr("AccessToken")) {
      this.accessToken = this.cfgStr("AccessToken");
      this.expiredAt = Date.now() + 90 * 86400 * 1000;
      return this.accessToken;
    }
    throw new Error("123_open: 缺少认证（ClientID/ClientSecret 或 AccessToken）");
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { authorization: "Bearer " + (await this.ensureToken()), platform: "open_platform", "Content-Type": "application/json" };
  }

  private async api<T>(pathname: string, params: Record<string, string>, method = "GET", body?: unknown, retried = false): Promise<T> {
    const h = await this.hdrs();
    const url = params && method === "GET" ? `${API}${pathname}?${new URLSearchParams(params).toString()}` : `${API}${pathname}`;
    const r = await fetch(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const j = (await r.json()) as any;
    if (j.code === 401) {
      if (retried) throw new Error(`123_open: ${j.message || "认证失败"}`);
      this.accessToken = "";
      this.expiredAt = 0;
      return this.api<T>(pathname, params, method, body, true);
    }
    if (j.code !== 0) throw new Error(`123_open: ${j.message}`);
    return j as T;
  }

  private async resolveId(path: string): Promise<string> {
    if (path === "/") return "0";
    let pdir = "0";
    for (const seg of path.split("/").filter(Boolean)) {
      let last = 0;
      let found: any = null;
      for (;;) {
        const j = await this.api<{ data: { fileList: any[]; lastFileId: number } }>("/api/v2/file/list", {
          parentFileId: pdir, limit: "100", lastFileId: String(last), trashed: "false", searchMode: "", searchData: "",
        });
        for (const f of j.data.fileList || []) {
          if (f.trashed === 0 && f.filename === seg) { found = f; break; }
        }
        if (found || j.data.lastFileId === -1 || (j.data.fileList || []).length === 0) break;
        last = j.data.lastFileId;
      }
      if (!found) throw new Error(`123_open: 路径不存在 ${path}`);
      pdir = String(found.fileId);
    }
    return pdir;
  }

  private toItem(f: any, base: string): FileItem {
    return {
      name: f.filename,
      path: joinPath(base, f.filename),
      is_dir: f.type === 1,
      size: Number(f.size || 0),
      modified: f.updateAt ? Date.parse(f.updateAt) : 0,
      etag: String(f.fileId), // 此处 etag 存 numeric fileId，供下载/删除/重命名
    };
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.resolveId(path);
    const out: FileItem[] = [];
    let last = 0;
    for (;;) {
      const j = await this.api<{ data: { fileList: any[]; lastFileId: number } }>("/api/v2/file/list", {
        parentFileId: id, limit: "100", lastFileId: String(last), trashed: "false", searchMode: "", searchData: "",
      });
      for (const f of j.data.fileList || []) if (f.trashed === 0) out.push(this.toItem(f, path));
      if (j.data.lastFileId === -1 || (j.data.fileList || []).length === 0) break;
      last = j.data.lastFileId;
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    if (path === "/") return { name: "", path: "/", is_dir: true, size: 0, modified: 0 };
    const parent = path.split("/").slice(0, -1).join("/") || "/";
    const id = await this.resolveId(parent);
    let last = 0;
    for (;;) {
      const j = await this.api<{ data: { fileList: any[]; lastFileId: number } }>("/api/v2/file/list", {
        parentFileId: id, limit: "100", lastFileId: String(last), trashed: "false", searchMode: "", searchData: "",
      });
      const name = path.split("/").pop();
      const f = (j.data.fileList || []).find((x) => x.filename === name);
      if (f) return this.toItem(f, parent);
      if (j.data.lastFileId === -1 || (j.data.fileList || []).length === 0) break;
      last = j.data.lastFileId;
    }
    throw new Error(`123_open: 不存在 ${path}`);
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const item = await this.get(path);
    let url: string;
    if ((this.cfg as any).DirectLink) {
      const j = await this.api<{ data: { url: string } }>("/api/v1/direct-link/url", { fileID: String(item.etag) });
      url = j.data.url;
      const pk = this.cfgStr("DirectLinkPrivateKey");
      if (pk) url = this.signURL(url, pk, this.uid, Number(this.cfgStr("DirectLinkValidDuration") || 30));
    } else {
      const j = await this.api<{ data: { downloadUrl: string } }>("/api/v1/file/download_info", { fileId: String(item.etag) });
      url = j.data.downloadUrl;
    }
    return fetch(url, range ? { headers: { Range: range } } : {});
  }

  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(_path)}`, method: "PUT", headers: { "x-driver": "123_open" } };
  }

  // Worker 代理：V2 分片（multipart slice 上传 + 轮询 complete）
  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const parentId = await this.resolveId(path.split("/").slice(0, -1).join("/") || "/");
    const name = basename(path);
    const buf = new Uint8Array(await new Response(body).arrayBuffer());
    const etag = md5Hex(buf).toLowerCase();
    const create = await this.api<any>("/upload/v2/file/create", {}, "POST", {
      parentFileId: Number(parentId), filename: name, etag, size: buf.length, duplicate: 2, containDir: false,
    });
    if (create.data.reuse) return;
    const preuploadID = create.data.preuploadID;
    const sliceSize = create.data.sliceSize || 5 * 1024 * 1024;
    const server = create.data.servers?.[0];
    if (!server) throw new Error("123_open: 无上传服务器");
    const nSlices = Math.max(1, Math.ceil(buf.length / sliceSize));
    for (let i = 0; i < nSlices; i++) {
      const start = i * sliceSize;
      const slice = buf.slice(start, Math.min(start + sliceSize, buf.length));
      const sliceMD5 = md5Hex(slice);
      const form = new FormData();
      form.append("preuploadID", preuploadID);
      form.append("sliceNo", String(i + 1));
      form.append("sliceMD5", sliceMD5);
      form.append("slice", new Blob([slice]), `${name}.part${i + 1}`);
      const r = await fetch(`${server}/upload/v2/file/slice`, {
        method: "POST",
        headers: { Authorization: "Bearer " + this.accessToken, Platform: "open_platform" },
        body: form,
      });
      const j = (await r.json()) as any;
      if (j.code !== 0) throw new Error(`123_open: 分片 ${i + 1} 失败 ${j.message}`);
    }
    for (let attempt = 0; attempt < 60; attempt++) {
      const c = await this.api<any>("/upload/v2/file/upload_complete", {}, "POST", { preuploadID });
      if (c.data.completed && c.data.fileID) return;
      await new Promise((res) => setTimeout(res, 1000));
    }
    throw new Error("123_open: 上传完成超时");
  }

  async mkdir(path: string): Promise<void> {
    const parentId = await this.resolveId(path.split("/").slice(0, -1).join("/") || "/");
    await this.api("/upload/v1/file/mkdir", {}, "POST", { parentID: Number(parentId), name: basename(path) });
  }
  async remove(path: string): Promise<void> {
    const item = await this.get(path);
    await this.api("/api/v1/file/trash", {}, "POST", { fileIDs: [Number(item.etag)] });
  }
  async rename(from: string, to: string): Promise<void> {
    const item = await this.get(from);
    await this.api("/api/v1/file/name", {}, "PUT", { fileId: Number(item.etag), fileName: basename(to) });
  }
  async move(from: string, to: string): Promise<void> {
    const item = await this.get(from);
    const dest = await this.resolveId(to.split("/").slice(0, -1).join("/") || "/");
    await this.api("/api/v1/file/move", {}, "POST", { fileIDs: [Number(item.etag)], toParentFileID: Number(dest) });
  }

  private signURL(originURL: string, privateKey: string, uid: number, validDuration: number): string {
    const u = new URL(originURL);
    const ts = Math.floor(Date.now() / 1000) + validDuration * 60;
    const rand = crypto.randomUUID().replace(/-/g, "");
    const authKey = `${ts}-${rand}-${uid}-${md5Hex(`${u.pathname}-${ts}-${rand}-${uid}-${privateKey}`)}`;
    u.searchParams.set("auth_key", authKey);
    return u.toString();
  }
}

export type _Avoid = Env | DriverConfig;
