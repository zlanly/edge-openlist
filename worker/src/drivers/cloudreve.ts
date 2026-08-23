import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, type TokenSet } from "../util/tokenstore";

// Cloudreve v3（自有 API + 上传会话）。端点/参数按 OpenList drivers/cloudreve 移植。
// 上传按存储策略分片：local 走服务端 /file/upload/{sessionID}/{chunk}，s3/remote/onedrive 直传 UploadURLs。
export class CloudreveDriver extends CloudBase {
  readonly id = "cloudreve";
  private address = "";
  private cookie = "";
  private ua = "";
  private idOf = new Map<string, string>();

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.address = (this.cfgStr("address") || "").replace(/\/+$/, "");
    this.ua = this.cfgStr("custom_ua") || "Mozilla/5.0";
    if (this.cfgStr("cookie")) this.cookie = this.cfgStr("cookie");
    else {
      const t = await loadTokens(this.env.KV, this.mountId);
      if (t?.access_token) this.cookie = t.access_token;
    }
    if (!this.cookie && this.cfgStr("username")) await this.login();
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Cookie: `cloudreve-session=${this.cookie}` };
  }

  private async login(): Promise<void> {
    const r = await fetch(`${this.address}/api/v3/user/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username: this.cfgStr("username"), Password: this.cfgStr("password"), captchaCode: "" }),
    });
    if (!r.ok) throw new Error(`Cloudreve 登录失败: ${r.status}`);
    const j = (await r.json()) as any;
    if (j.code !== 0) throw new Error(`Cloudreve 登录失败: ${j.msg}`);
    const sc = r.headers.get("set-cookie");
    if (sc) {
      const m = sc.match(/cloudreve-session=([^;]+)/);
      if (m) this.cookie = m[1];
    }
    const t: TokenSet = { access_token: this.cookie, expires_at: Date.now() + 86400 * 1000 * 7 };
    await saveTokens(this.env.KV, this.mountId, t);
  }

  private async api(method: string, path: string, opts: { query?: Record<string, string>; body?: any; raw?: boolean } = {}): Promise<any> {
    if (!this.cookie) await this.login();
    const url = new URL(`${this.address}/api/v3${path}`);
    if (opts.query) for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
    let resp = await fetch(url.toString(), {
      method,
      headers: { Cookie: `cloudreve-session=${this.cookie}`, Accept: "application/json", "User-Agent": this.ua, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (resp.status === 401 && this.cfgStr("username")) {
      this.cookie = "";
      await this.login();
      resp = await fetch(url.toString(), {
        method,
        headers: { Cookie: `cloudreve-session=${this.cookie}`, Accept: "application/json", "User-Agent": this.ua, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    }
    if (!resp.ok) throw new Error(`Cloudreve ${method} ${path} 失败: ${resp.status}`);
    if (opts.raw) return await resp.text();
    const j = (await resp.json()) as any;
    if (j.code !== 0) throw new Error(`Cloudreve 错误: ${j.msg}`);
    return j.data;
  }

  async list(path: string): Promise<FileItem[]> {
    const data = await this.api("GET", `/directory${normalizePath(path)}`);
    const objs = (data.objects || []) as any[];
    return objs.map((o) => {
      const p = joinPath(path, o.name);
      this.idOf.set(p, o.id);
      return {
        name: o.name,
        path: p,
        is_dir: o.type === "dir",
        size: Number(o.size || 0),
        modified: o.date ? Date.parse(o.date) : 0,
      };
    });
  }

  async get(path: string): Promise<FileItem> {
    const items = await this.list(parentPath(path));
    const name = basename(path);
    const it = items.find((i) => i.name === name);
    if (!it) throw new Error("文件不存在");
    return it;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const item = (await this.list(parentPath(path))).find((i) => i.name === basename(path));
    if (!item) throw new Error("文件不存在");
    const id = this.idOf.get(item.path) || item.path;
    const url = (await this.api("PUT", `/file/download/${id}`, {})) as unknown as string;
    let u = url.replace(/^"|"$/g, "");
    if (u.startsWith("/api")) u = this.address + u;
    return fetch(u, { headers: { Referer: this.address, "User-Agent": this.ua, ...(range ? { Range: range } : {}) } });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "cloudreve" } };
  }

  async putContent(path: string, stream: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const dstDir = normalizePath(parentPath(path));
    const dir = await this.api("GET", `/directory${dstDir}`);
    const policyType = dir.policy?.type || "local";
    const u = (await this.api("PUT", `/file/upload`, {
      body: { path: dstDir, size, name: basename(path), policy_id: dir.policy?.id, last_modified: Date.now() },
    })) as any;
    const chunkSize = u.chunkSize || 5 * 1024 * 1024;
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
      if (policyType === "local") {
        const r = await fetch(`${this.address}/api/v3/file/upload/${u.sessionID}/${chunk}`, {
          method: "POST",
          headers: { Cookie: `cloudreve-session=${this.cookie}`, "Content-Type": "application/octet-stream", "Content-Length": String(off), "User-Agent": this.ua },
          body: piece,
        });
        if (!r.ok) throw new Error(`Cloudreve 分片上传失败: ${r.status}`);
      } else if (policyType === "onedrive") {
        const r = await fetch(u.uploadURLs[0], {
          method: "PUT",
          headers: { "Content-Range": `bytes ${finish}-${finish + off - 1}/${size}`, "User-Agent": this.ua },
          body: piece,
        });
        if (r.status < 200 || (r.status >= 300 && r.status !== 202 && r.status !== 201)) throw new Error(`Cloudreve OneDrive 上传失败: ${r.status}`);
      } else if (policyType === "s3" || policyType === "ks3") {
        const r = await fetch(u.uploadURLs[chunk], { method: "PUT", headers: { "User-Agent": this.ua }, body: piece });
        if (!r.ok) throw new Error(`Cloudreve S3 上传失败: ${r.status}`);
        const et = r.headers.get("ETag");
        if (!et) throw new Error("Cloudreve S3 上传缺少 ETag");
        etags.push(et);
      } else {
        // remote
        const r = await fetch(`${u.uploadURLs[0]}?chunk=${chunk}`, {
          method: "POST",
          headers: { Authorization: String(u.credential), "User-Agent": this.ua },
          body: piece,
        });
        if (!r.ok) throw new Error(`Cloudreve remote 上传失败: ${r.status}`);
      }
      finish += off;
      chunk++;
    }
    if (finish !== size) throw new Error(`Cloudreve 上传大小不一致：声明 ${size}，实际 ${finish}`);
    if (policyType === "s3" || policyType === "ks3") {
      let xml = "<CompleteMultipartUpload>";
      etags.forEach((e, i) => (xml += `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`));
      xml += "</CompleteMultipartUpload>";
      const r = await fetch(u.complete_url, { method: "POST", headers: { "Content-Type": "application/xml", "User-Agent": this.ua }, body: xml });
      if (!r.ok) throw new Error(`Cloudreve S3 完成失败: ${r.status}`);
      await this.api("GET", `/callback/s3/${u.sessionID}`);
    } else if (policyType === "onedrive") {
      await this.api("POST", `/callback/onedrive/finish/${u.sessionID}`, { body: {} });
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.api("PUT", `/directory`, { body: { path: normalizePath(path) } });
  }

  async remove(path: string): Promise<void> {
    const item = await this.get(path);
    const id = this.idOf.get(item.path) || item.path;
    const src = item.is_dir ? { dirs: [id], items: [] } : { dirs: [], items: [id] };
    await this.api("DELETE", `/object`, { body: src });
  }

  async rename(from: string, to: string): Promise<void> {
    const item = await this.get(from);
    const id = this.idOf.get(item.path) || item.path;
    await this.api("PATCH", `/object/rename`, { body: { action: "rename", new_name: basename(to), src: { dirs: item.is_dir ? [id] : [], items: item.is_dir ? [] : [id] } } });
  }

  async move(from: string, to: string): Promise<void> {
    const item = await this.get(from);
    const id = this.idOf.get(item.path) || item.path;
    await this.api("PATCH", `/object`, {
      body: { action: "move", src_dir: normalizePath(parentPath(from)), dst: normalizePath(parentPath(to)), src: { dirs: item.is_dir ? [id] : [], items: item.is_dir ? [] : [id] } },
    });
  }
}
