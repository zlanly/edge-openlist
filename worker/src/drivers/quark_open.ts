import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";
import { md5Hex, sha1Hex } from "../util/md5";

const API = "https://open-api-drive.quark.cn";

// 夸克网盘开放平台（signature + refresh_token 模式）
export class QuarkOpenDriver extends CloudBase {
  readonly id = "quark_open";
  private userId = "";
  private appId = "";
  private signKey = "";
  private accessToken = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  private cfgBool(k: string, d = false): boolean {
    const v = (this.cfg as Record<string, unknown>)[k];
    return typeof v === "boolean" ? v : d;
  }

  // ---- 令牌：refresh_token -> 在线 API 换发 access_token / app_id / sign_key ----
  private async ensureToken(): Promise<void> {
    let t = await loadTokens(this.env.KV, this.mountId);
    if (isExpired(t)) {
      const rt = this.cfgStr("refreshToken") || t?.refresh_token || "";
      if (!rt) throw new Error("quark_open: 缺少 refresh_token");
      const api = this.cfgStr("api_url_address") || "https://api.oplist.org/quarkyun/renewapi";
      const url = `${api}?refresh_ui=${encodeURIComponent(rt)}&server_use=true&driver_txt=quarkyun_oa`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`quark_open: 令牌刷新失败 ${r.status}`);
      const j = (await r.json()) as any;
      if (!j.access_token || !j.refresh_token) {
        throw new Error(`quark_open: ${j.text || "令牌刷新返回空"}`);
      }
      t = {
        access_token: j.access_token,
        refresh_token: j.refresh_token,
        expires_at: Date.now() + 30 * 24 * 3600 * 1000,
        extra: { app_id: j.app_id, sign_key: j.sign_key },
      };
      await saveTokens(this.env.KV, this.mountId, t);
    }
    this.accessToken = t!.access_token;
    this.appId = (t!.extra?.app_id as string) || this.cfgStr("app_id") || "";
    this.signKey = (t!.extra?.sign_key as string) || this.cfgStr("sign_key") || "";
  }

  // ---- 签名头：x-pan-tm / x-pan-token / x-pan-client-id ----
  private async signedHeaders(method: string, pathname: string): Promise<Record<string, string>> {
    await this.ensureToken();
    const makeHeaders = async () => {
      const ts = String(Date.now());
      const token = await sha256Hex(`${method}&${pathname}&${ts}&${this.signKey}`);
      return {
        Accept: "application/json, text/plain, */*",
        "User-Agent": "go-resty/3.0.0-beta.1 (https://resty.dev)",
        "x-pan-tm": ts,
        "x-pan-token": token,
        "x-pan-client-id": this.appId,
      };
    };
    if (!this.userId) {
      const infoHeaders = await makeHeaders();
      const info = await fetch(`${API}/open/v1/user/info?access_token=${encodeURIComponent(this.accessToken)}`, { headers: infoHeaders });
      if (!info.ok) throw new Error(`quark_open 用户信息失败 ${info.status}`);
      const data = (await info.json()) as { data?: { user_id?: string } };
      if (!data.data?.user_id) throw new Error("quark_open 用户信息缺少 user_id");
      this.userId = data.data.user_id;
    }
    return makeHeaders();
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return this.signedHeaders("GET", "/open/v1/user/info");
  }

  // GET 带签名 + access_token 查询
  private async gget<T>(pathname: string, params: Record<string, string> = {}): Promise<T> {
    const h = await this.signedHeaders("GET", pathname);
    const q = new URLSearchParams({ access_token: this.accessToken, ...params }).toString();
    const r = await fetch(`${API}${pathname}?${q}`, { headers: h });
    if (!r.ok) throw new Error(`quark_open GET ${r.status} ${pathname}`);
    const j = (await r.json()) as any;
    if (j.status && j.status >= 400) throw new Error(`quark_open: ${j.error_info || j.errno}`);
    return j as T;
  }

  private async gpost<T>(pathname: string, body: unknown, params: Record<string, string> = {}): Promise<T> {
    const h = await this.signedHeaders("POST", pathname);
    const q = new URLSearchParams({ access_token: this.accessToken, ...params }).toString();
    const r = await fetch(`${API}${pathname}?${q}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...h },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`quark_open POST ${r.status} ${pathname}`);
    const j = (await r.json()) as any;
    if (j.status && j.status >= 400) throw new Error(`quark_open: ${j.error_info || j.errno}`);
    return j as T;
  }

  // 路径 -> fid（开放 API 无 get_by_path，逐段列表匹配）
  private async resolveId(path: string): Promise<string> {
    if (path === "/") return "0";
    let pdir = "0";
    for (const seg of path.split("/").filter(Boolean)) {
      let cursor: any = undefined;
      let item: any;
      for (;;) {
        const body: any = { parent_fid: pdir, size: 100, sort: "file_name:asc" };
        if (cursor) body.query_cursor = cursor;
        const j = await this.gpost<{ data: { file_list: any[]; last_page: boolean; next_query_cursor: any } }>("/open/v1/file/list", body);
        item = (j.data.file_list || []).find((f) => f.filename === seg);
        if (item || j.data.last_page) break;
        const next = j.data.next_query_cursor;
        if (!next || next === cursor) break;
        cursor = next;
      }
      if (!item) throw new Error(`quark_open: 路径不存在 ${path}`);
      pdir = item.fid;
    }
    return pdir;
  }

  private toItem(f: any, base: string): FileItem {
    return {
      name: f.filename,
      path: joinPath(base, f.filename),
      is_dir: f.file_type === "0",
      size: Number(f.size || 0),
      modified: f.updated_at ? Number(f.updated_at) : 0,
      etag: f.fid,
    };
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.resolveId(path);
    const out: FileItem[] = [];
    let cursor: any = undefined;
    for (;;) {
      const body: any = { parent_fid: id, size: 100, sort: "file_name:asc" };
      if (cursor) body.query_cursor = cursor;
      const j = await this.gpost<{ data: { file_list: any[]; last_page: boolean; next_query_cursor: any } }>(
        "/open/v1/file/list",
        body
      );
      for (const f of j.data.file_list || []) out.push(this.toItem(f, path));
      if (j.data.last_page) break;
      cursor = j.data.next_query_cursor;
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    if (path === "/") return { name: "", path: "/", is_dir: true, size: 0, modified: 0 };
    const parent = path.split("/").slice(0, -1).join("/") || "/";
    const id = await this.resolveId(parent);
    const j = await this.gpost<{ data: { file_list: any[] } }>("/open/v1/file/list", { parent_fid: id, size: 100, sort: "file_name:asc" });
    const name = path.split("/").pop();
    const f = (j.data.file_list || []).find((x) => x.filename === name);
    if (!f) throw new Error(`quark_open: 不存在 ${path}`);
    return this.toItem(f, parent);
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const fid = await this.resolveId(path);
    const j = await this.gpost<{ data: { download_url: string } }>("/open/v1/file/get_download_url", { fid });
    const cookie = `x_pan_client_id=${this.appId}; x_pan_access_token=${this.accessToken}`;
    return fetch(j.data.download_url, { headers: { Cookie: cookie, ...(range ? { Range: range } : {}) } });
  }

  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    // 开放平台为 OSS 分片直传，需 Worker 代理（签名在 putContent 内完成）
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(_path)}`, method: "PUT", headers: { "x-driver": "quark_open" } };
  }

  // Worker 代理：OSS 分片直传 + 秒传（需整文件以计算 md5/sha1/proof，见报告说明）
  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    await this.ensureToken();
    const parentId = await this.resolveId(path.split("/").slice(0, -1).join("/") || "/");
    const name = basename(path);
    const buf = new Uint8Array(await new Response(body).arrayBuffer());
    const md5 = md5Hex(buf);
    const sha1 = await sha1Hex(buf);

    // proof 计算（与 OpenList 同源）
    const ts = String(Date.now());
    const token = await sha256Hex(`POST&/open/v1/file/upload_pre&${ts}&${this.signKey}`);
    const proofSeed1 = md5Hex(this.userId + token);
    const proofSeed2 = md5Hex(String(buf.length));
    const off1 = Number("0x" + md5Hex(proofSeed1).slice(0, 16)) % (buf.length || 1);
    const off2 = Number("0x" + md5Hex(proofSeed2).slice(0, 16)) % (buf.length || 1);
    const sliceAt = (off: number) => buf.slice(off, Math.min(off + 8, buf.length));
    const proofCode1 = btoa(String.fromCharCode(...sliceAt(off1)));
    const proofCode2 = btoa(String.fromCharCode(...sliceAt(off2)));

    const pre = await this.gpost<any>("/open/v1/file/upload_pre", {
      file_name: name,
      size: buf.length,
      format_type: _ct || "application/octet-stream",
      md5,
      sha1,
      l_created_at: Date.now(),
      l_updated_at: Date.now(),
      pdir_fid: parentId,
      same_path_reuse: true,
      proof_version: "v1",
      proof_seed1: proofSeed1,
      proof_seed2: proofSeed2,
      proof_code1: proofCode1,
      proof_code2: proofCode2,
    });
    if (pre.data?.finish) return; // 秒传命中

    const partSize = pre.data.part_size || 4 * 1024 * 1024;
    const total = buf.length;
    const partInfo: any[] = [];
    let left = total, n = 1;
    while (left > 0) {
      const ps = Math.min(partSize, left);
      partInfo.push({ part_number: n, part_size: ps });
      left -= ps; n++;
    }
    const up = await this.gpost<any>("/open/v1/file/get_upload_urls", { task_id: pre.data.task_id, part_info_list: partInfo });
    const urls = up.data.upload_urls as any[];
    const common = up.data.common_headers || {};
    const etags: string[] = [];
    for (let i = 0; i < urls.length; i++) {
      const u = urls[i];
      const start = (i) * partSize;
      const slice = buf.slice(start, start + (partInfo[i].part_size));
      const r = await fetch(u.upload_url, {
        method: "PUT",
        headers: {
          Authorization: u.signature_info?.signature || "",
          "X-Oss-Date": common.XOssDate || "",
          "X-Oss-Content-Sha256": common.XOssContentSha256 || "",
          "Content-Type": "application/octet-stream",
        },
        body: slice,
      });
      if (!r.ok) throw new Error(`quark_open: 分片 ${i} 上传失败 ${r.status}`);
      etags.push(r.headers.get("Etag") || "");
    }
    const finList = partInfo.map((p, i) => ({ part_number: p.part_number, part_size: p.part_size, etag: etags[i] }));
    const fin = await this.gpost<any>("/open/v1/file/upload_finish", { task_id: pre.data.task_id, part_info_list: finList });
    if (!fin.data?.finish) throw new Error("quark_open: 上传完成失败");
  }

  async mkdir(path: string): Promise<void> {
    const parentId = await this.resolveId(path.split("/").slice(0, -1).join("/") || "/");
    await this.gpost("/open/v1/dir", { dir_path: basename(path), pdir_fid: parentId });
  }

  async remove(path: string): Promise<void> {
    const fid = await this.resolveId(path);
    await this.gpost("/open/v1/file/delete", { action_type: 1, fid_list: [fid] });
  }

  async rename(from: string, to: string): Promise<void> {
    const fid = await this.resolveId(from);
    await this.gpost("/open/v1/file/rename", { fid, file_name: basename(to), conflict_mode: "REUSE" });
  }

  async move(from: string, to: string): Promise<void> {
    const fid = await this.resolveId(from);
    const dest = await this.resolveId(to.split("/").slice(0, -1).join("/") || "/");
    await this.gpost("/open/v1/file/move", { action_type: 1, fid_list: [fid], to_pdir_fid: dest });
  }
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type _Avoid = Env | DriverConfig;
