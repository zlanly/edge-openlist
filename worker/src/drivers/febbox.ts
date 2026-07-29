import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";

// FebBox 驱动（OpenList drivers/febbox）
// 认证：OAuth2 client_credentials / refresh_token，令牌存 KV。
// 上传：NoUpload（OpenList config NoUpload:true），走 Worker 代理并返回 NotImplement。
// API 端点已对照 openlist-src/drivers/febbox/*.go 核实。
const API = "https://api.febbox.com/oauth";

export class FebBoxDriver extends CloudBase {
  readonly id = "febbox";
  private accessToken = "";
  private tokenType = "Bearer";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  // 从 KV 读取或刷新 OAuth2 令牌
  private async ensureToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    let t = await loadTokens(this.env.KV, this.mountId);
    if (isExpired(t)) {
      t = await this.fetchToken(t?.refresh_token || "");
    }
    this.accessToken = t!.access_token;
    this.tokenType = t!.extra?.token_type || "Bearer";
    return this.accessToken;
  }

  private async fetchToken(refreshToken: string): Promise<TokenSet> {
    const body = new URLSearchParams();
    if (refreshToken) {
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", refreshToken);
    } else {
      body.set("grant_type", "client_credentials");
    }
    body.set("client_id", this.cfgStr("client_id"));
    body.set("client_secret", this.cfgStr("client_secret"));
    const r = await fetch("https://api.febbox.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const j = (await r.json()) as any;
    if (j.code !== 1) throw new Error(`FebBox 令牌获取失败: ${j.msg}`);
    const d = j.data;
    const t: TokenSet = {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000,
      extra: { token_type: d.token_type || "Bearer" },
    };
    await saveTokens(this.env.KV, this.mountId, t);
    return t;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    const tk = await this.ensureToken();
    return { Authorization: `${this.tokenType} ${tk}` };
  }

  // 统一的 multipart POST（对照 util.go request + getFiles/getDownloadLink 等）
  private async api(
    module: string,
    fields: Record<string, string>,
    respType: "json"
  ): Promise<any> {
    const fd = new FormData();
    fd.set("module", module);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    const r = await fetch(API, { method: "POST", headers: await this.hdrs(), body: fd });
    if (!r.ok) throw new Error(`FebBox POST ${module} ${r.status}`);
    const j = (await r.json()) as any;
    // -10001 且服务端返回 ServerName 表示 access_token 过期，刷新后重试一次
    if (j.code === -10001 && j.server_name) {
      this.accessToken = "";
      const tk = await this.ensureToken();
      const r2 = await fetch(API, {
        method: "POST",
        headers: { Authorization: `${this.tokenType} ${tk}` },
        body: fd,
      });
      const j2 = (await r2.json()) as any;
      if (j2.code !== 0 && j2.code !== 1) throw new Error(`FebBox ${module}: ${j2.msg}`);
      return j2;
    }
    if (j.code !== 0 && j.code !== 1) throw new Error(`FebBox ${module}: ${j.msg}`);
    return j;
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.resolveId(path);
    const pageSize = Number(this.cfgStr("page_size")) || 100;
    const sort = this.cfgStr("sort_rule") || "name_asc";
    const out: FileItem[] = [];
    let page = 1;
    for (;;) {
      const j = await this.api("file_list", {
        parent_id: id,
        page: String(page),
        pagelimit: String(pageSize),
        order: sort,
      }, "json");
      const list: any[] = (j.data && j.data.file_list) || [];
      for (const f of list) {
        out.push({
          name: f.file_name,
          path: joinPath(path, f.file_name),
          is_dir: f.is_dir === 1,
          size: Number(f.file_size) || 0,
          modified: (f.file_update_time ? f.file_update_time : f.update_time || 0) * 1000,
          etag: String(f.fid),
        });
      }
      if (list.length < pageSize) break;
      page++;
    }
    return out;
  }

  private async resolveId(path: string): Promise<string> {
    // 根目录默认 "0"（对照 DefaultRoot）
    if (path === "/") return this.cfgStr("root_id") || "0";
    // FebBox 以数字 fid 作路径，逐段累积父级不可行；采用 OpenList 行为：
    // 列表仅支持 parent_id，因此对外路径直接取最后一段作为 fid。
    return basename(path);
  }

  async get(path: string): Promise<FileItem> {
    const parent = parentPath(path);
    const items = await this.list(parent);
    const it = items.find((i) => i.path === path);
    if (!it) throw new Error(`FebBox 未找到: ${path}`);
    return it;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const id = basename(path);
    const ip = this.cfgStr("user_ip") || "";
    const j = await this.api("file_get_download_url", { "fids[]": id, ip }, "json");
    const data = (j.data && j.data[0]) || {};
    if (!data.download_url) throw new Error(`FebBox 获取下载链接失败: ${j.msg}`);
    return fetch(data.download_url, range ? { headers: { Range: range } } : {});
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    // OpenList config NoUpload:true，不支持上传
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "febbox" } };
  }

  async putContent(): Promise<void> {
    throw new Error("FebBox 驱动不支持上传 (NoUpload)");
  }

  async mkdir(path: string): Promise<void> {
    const parent = parentPath(path);
    await this.api("create_dir", { parent_id: basename(parent), name: basename(path) }, "json");
  }

  async remove(path: string): Promise<void> {
    await this.api("file_delete", { "fids[]": basename(path) }, "json");
  }

  async rename(from: string, to: string): Promise<void> {
    await this.api("file_rename", { fid: basename(from), name: basename(to) }, "json");
  }

  async move(from: string, to: string): Promise<void> {
    await this.api("file_move", { "fids[]": basename(from), to: basename(to) }, "json");
  }
}
