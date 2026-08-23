import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";

// Cloudreve v4（Bearer token + 上传会话）。端点/参数按 OpenList drivers/cloudreve_v4 移植。
// 上传按存储策略分片：local/relay 走 /file/upload/{session_id}/{chunk}，s3/ks3/remote/onedrive 直传 UploadURLs。
export class CloudreveV4Driver extends CloudBase {
  readonly id = "cloudreve_v4";
  private address = "";
  private ua = "";
  private access = "";
  private refresh = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.address = (this.cfgStr("address") || "").replace(/\/+$/, "");
    this.ua = this.cfgStr("custom_ua") || "Mozilla/5.0";
    this.access = this.cfgStr("access_token") || "";
    this.refresh = this.cfgStr("refresh_token") || "";
    if (!this.access) {
      const t = await loadTokens(this.env.KV, this.mountId);
      if (t?.access_token) {
        this.access = t.access_token;
        this.refresh = t.refresh_token || "";
      }
    }
    if (!this.access && this.cfgStr("username")) await this.login();
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return this.access ? { Authorization: `Bearer ${this.access}` } : {};
  }

  private async login(): Promise<void> {
    // 跳过验证码（仅 normal 支持），直接尝试登录
    const r = await fetch(`${this.address}/api/v4/session/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: this.cfgStr("username"), password: this.cfgStr("password") }),
    });
    if (!r.ok) throw new Error(`CloudreveV4 登录失败: ${r.status}`);
    const j = (await r.json()) as any;
    if (j.code !== 0) throw new Error(`CloudreveV4 登录失败: ${j.msg}`);
    this.access = j.data.token.access_token;
    this.refresh = j.data.token.refresh_token;
    await this.save();
  }

  private async refreshTok(): Promise<void> {
    if (!this.refresh) {
      if (this.cfgStr("username")) await this.login();
      return;
    }
    const r = await fetch(`${this.address}/api/v4/session/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refresh_token: this.refresh }),
    });
    const j = (await r.json()) as any;
    if (j.code !== 0) {
      if (this.cfgStr("username")) await this.login();
      return;
    }
    this.access = j.data.access_token;
    this.refresh = j.data.refresh_token;
    await this.save();
  }

  private async save(): Promise<void> {
    const t: TokenSet = { access_token: this.access, refresh_token: this.refresh, expires_at: Date.now() + 3600 * 1000 };
    await saveTokens(this.env.KV, this.mountId, t);
  }

  private async api(method: string, path: string, opts: { query?: Record<string, string>; body?: any; raw?: boolean } = {}): Promise<any> {
    if (!this.access) await this.login();
    const url = new URL(`${this.address}/api/v4${path}`);
    if (opts.query) for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
    let resp = await fetch(url.toString(), {
      method,
      headers: { Authorization: `Bearer ${this.access}`, Accept: "application/json", "User-Agent": this.ua, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (resp.status === 401) {
      await this.refreshTok();
      resp = await fetch(url.toString(), {
        method,
        headers: { Authorization: `Bearer ${this.access}`, Accept: "application/json", "User-Agent": this.ua, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    }
    if (!resp.ok) throw new Error(`CloudreveV4 ${method} ${path} 失败: ${resp.status}`);
    if (opts.raw) return await resp.text();
    const j = (await resp.json()) as any;
    if (j.code !== 0) throw new Error(`CloudreveV4 错误: ${j.msg}`);
    return j.data;
  }

  async list(path: string): Promise<FileItem[]> {
    const items: FileItem[] = [];
    let token = "";
    for (;;) {
      const q: Record<string, string> = { uri: normalizePath(path), page_size: "100", order_by: this.cfgStr("order_by") || "name", order_direction: this.cfgStr("order_direction") || "asc", page: "0" };
      if (token) q["next_page_token"] = token;
      const data = await this.api("GET", `/file`, { query: q });
      for (const f of data.files as any[]) {
        items.push({ name: f.name, path: joinPath(path, f.name), is_dir: f.type === 1, size: Number(f.size || 0), modified: f.updated_at ? Date.parse(f.updated_at) : 0 });
      }
      if (!data.pagination?.next_token || (data.files as any[]).length < 100) break;
      token = data.pagination.next_token;
    }
    return items;
  }

  async get(path: string): Promise<FileItem> {
    const info = (await this.api("GET", `/file/info`, { query: { uri: normalizePath(path) } })) as any;
    return { name: info.name, path, is_dir: info.type === 1, size: Number(info.size || 0), modified: info.updated_at ? Date.parse(info.updated_at) : 0 };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const data = (await this.api("POST", `/file/url`, { body: { uris: [normalizePath(path)], download: true } })) as any;
    if (!data.urls || !data.urls.length) throw new Error("CloudreveV4 无下载地址");
    return fetch(data.urls[0].url, range ? { headers: { Range: range, Referer: this.address, "User-Agent": this.ua } } : { headers: { Referer: this.address, "User-Agent": this.ua } });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "cloudreve_v4" } };
  }

  async putContent(path: string, stream: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const dstDir = normalizePath(parentPath(path));
    const dir = await this.api("GET", `/file`, { query: { uri: dstDir, page_size: "10", order_by: "created_at", order_direction: "asc", page: "0" } });
    const policy = dir.storage_policy || { type: "local" };
    const u = (await this.api("PUT", `/file/upload`, {
      body: { uri: `${dstDir}/${basename(path)}`, size, policy_id: policy.id, last_modified: Date.now(), mime_type: "" },
    })) as any;
    const chunkSize = u.chunk_size || 5 * 1024 * 1024;
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const etags: string[] = [];
    let finish = 0;
    let chunk = 0;
    let carry = new Uint8Array(0);
    for (;;) {
      const buf = new Uint8Array(chunkSize);
      let off = 0;
      while (off < chunkSize) {
        let value: Uint8Array;
        if (carry.length) { value = carry; carry = new Uint8Array(0); }
        else {
          const next = await reader.read();
          if (next.done) break;
          value = next.value;
        }
        if (!value.length) continue;
        const take = Math.min(value.length, chunkSize - off);
        buf.set(value.subarray(0, take), off);
        off += take;
        if (take < value.length) carry = value.slice(take);
      }
      if (off === 0) break;
      const piece = buf.slice(0, off);
      if (policy.type === "local" || policy.relay) {
        const r = await fetch(`${this.address}/api/v4/file/upload/${u.session_id}/${chunk}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.access}`, "Content-Type": "application/octet-stream", "Content-Length": String(off), "User-Agent": this.ua },
          body: piece,
        });
        if (!r.ok) throw new Error(`CloudreveV4 分片上传失败: ${r.status}`);
      } else if (policy.type === "onedrive") {
        const r = await fetch(u.upload_urls[0], { method: "PUT", headers: { "Content-Range": `bytes ${finish}-${finish + off - 1}/${size}`, "User-Agent": this.ua }, body: piece });
        if (r.status < 200 || (r.status >= 300 && r.status !== 202 && r.status !== 201)) throw new Error(`CloudreveV4 OneDrive 上传失败: ${r.status}`);
      } else if (policy.type === "s3" || policy.type === "ks3") {
        const r = await fetch(u.upload_urls[chunk], { method: "PUT", headers: { "User-Agent": this.ua, ...(policy.type === "ks3" ? { "Content-Type": "application/octet-stream" } : {}) }, body: piece });
        if (!r.ok) throw new Error(`CloudreveV4 S3 上传失败: ${r.status}`);
        const et = r.headers.get("ETag");
        if (!et) throw new Error("CloudreveV4 S3 上传缺少 ETag");
        etags.push(et);
      } else {
        const r = await fetch(`${u.upload_urls[0]}?chunk=${chunk}`, { method: "POST", headers: { Authorization: String(u.credential), "User-Agent": this.ua }, body: piece });
        if (!r.ok) throw new Error(`CloudreveV4 remote 上传失败: ${r.status}`);
      }
      finish += off;
      chunk++;
    }
    if (policy.type === "s3" || policy.type === "ks3") {
      let xml = "<CompleteMultipartUpload>";
      etags.forEach((e, i) => (xml += `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`));
      xml += "</CompleteMultipartUpload>";
      const r = await fetch(u.complete_url, { method: "POST", headers: { "Content-Type": policy.type === "ks3" ? "application/octet-stream" : "application/xml", "User-Agent": this.ua }, body: xml });
      if (!r.ok) throw new Error(`CloudreveV4 S3 完成失败: ${r.status}`);
      await this.api("GET", `/callback/${policy.type}/${u.session_id}/${u.callback_secret}`);
    } else if (policy.type === "onedrive") {
      await this.api("POST", `/callback/onedrive/${u.session_id}/${u.callback_secret}`, { body: {} });
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.api("POST", `/file/create`, { body: { type: "folder", uri: normalizePath(path), error_on_conflict: true } });
  }

  async remove(path: string): Promise<void> {
    await this.api("DELETE", `/file`, { body: { uris: [normalizePath(path)], unlink: false, skip_soft_delete: true } });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.api("POST", `/file/rename`, { body: { new_name: basename(to), uri: normalizePath(from) } });
  }

  async move(from: string, to: string): Promise<void> {
    await this.api("POST", `/file/move`, { body: { uris: [normalizePath(from)], dst: normalizePath(parentPath(to)), copy: false } });
  }
}
