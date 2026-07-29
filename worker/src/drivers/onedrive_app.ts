import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";

// 端点与 OpenList drivers/onedrive_app/util.go 对齐
const hosts: Record<string, { oauth: string; api: string }> = {
  global: { oauth: "https://login.microsoftonline.com", api: "https://graph.microsoft.com" },
  cn: { oauth: "https://login.chinacloudapi.cn", api: "https://microsoftgraph.chinacloudapi.cn" },
  us: { oauth: "https://login.microsoftonline.us", api: "https://graph.microsoft.us" },
  de: { oauth: "https://login.microsoftonline.de", api: "https://graph.microsoft.de" },
};

function encodePath(p: string): string {
  return normalizePath(p).split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

// OneDrive 企业应用（client_credentials，应用级授权）
export class OnedriveAppDriver extends CloudBase {
  readonly id = "onedrive_app";
  private accessToken = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  private get region(): string {
    return this.cfgStr("region") || "global";
  }
  private get api(): string {
    return hosts[this.region]?.api || hosts.global.api;
  }
  private get oauth(): string {
    return hosts[this.region]?.oauth || hosts.global.oauth;
  }
  private get email(): string {
    return this.cfgStr("email");
  }

  // 对照 util.go GetMetaUrl(auth=false)
  private metaUrl(path: string): string {
    const p = encodePath(path);
    if (path === "/" || path === "\\") return `${this.api}/v1.0/users/${this.email}/drive/root`;
    return `${this.api}/v1.0/users/${this.email}/drive/root:${p}:`;
  }

  private async fetchToken(): Promise<TokenSet> {
    const tenant = this.cfgStr("tenant_id") || "common";
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.cfgStr("client_id"),
      client_secret: this.cfgStr("client_secret"),
      resource: this.api + "/",
      scope: this.api + "/.default",
    });
    const r = await fetch(`${this.oauth}/${tenant}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!r.ok)
      throw new Error(`onedrive_app token 失败 ${r.status}: ${await r.text().catch(() => "")}`);
    const j = (await r.json()) as any;
    if (!j.access_token) throw new Error("onedrive_app 返回空 access_token");
    return {
      access_token: j.access_token,
      expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
      extra: j,
    };
  }

  private async ensureToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    let t = await loadTokens(this.env.KV, this.mountId);
    if (isExpired(t)) {
      t = await this.fetchToken();
      await saveTokens(this.env.KV, this.mountId, t);
    }
    this.accessToken = t!.access_token;
    return this.accessToken;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.ensureToken()}` };
  }

  async list(path: string): Promise<FileItem[]> {
    let next = `${this.metaUrl(path)}/children?$top=1000&$expand=thumbnails($select=medium)&$select=id,name,size,lastModifiedDateTime,@microsoft.graph.downloadUrl,file,parentReference`;
    const out: FileItem[] = [];
    while (next) {
      const j = await this.jsonGet<any>(next);
      for (const it of j.value || []) {
        out.push({
          name: it.name,
          path: joinPath(path, it.name),
          is_dir: !it.file,
          size: Number(it.size || 0),
          modified: it.lastModifiedDateTime ? Date.parse(it.lastModifiedDateTime) : 0,
          etag: it.id,
        });
      }
      next = j["@odata.nextLink"] || "";
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    const it = await this.jsonGet<any>(this.metaUrl(path));
    return {
      name: basename(path),
      path,
      is_dir: !it.file,
      size: Number(it.size || 0),
      modified: it.lastModifiedDateTime ? Date.parse(it.lastModifiedDateTime) : 0,
      etag: it.id,
    };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const it = await this.jsonGet<any>(this.metaUrl(path));
    const dl = it["@microsoft.graph.downloadUrl"];
    if (!dl) throw new Error("无法获取下载链接");
    return fetch(dl, range ? { headers: { Range: range } } : {});
  }

  // createUploadSession 返回的 uploadUrl 可直接由客户端分片 PUT（带 Content-Range）
  async createUpload(path: string, _size: number): Promise<UploadSession> {
    const j = await this.jsonPost<{ uploadUrl: string }>(
      `${this.metaUrl(path)}/createUploadSession`,
      { "@microsoft.graph.conflictBehavior": "rename" }
    );
    return { uploadUrl: j.uploadUrl, method: "PUT" };
  }

  // Worker 代理分片上传（流式，避免整文件缓冲），对应 util.go upBig
  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const token = await this.ensureToken();
    const create = await this.jsonPost<any>(`${this.metaUrl(path)}/createUploadSession`, {
      "@microsoft.graph.conflictBehavior": "rename",
    });
    const uploadUrl: string = create.uploadUrl;
    if (!uploadUrl) throw new Error("onedrive_app 未返回 uploadUrl");
    const chunk = (this.cfg as any).chunk_size
      ? Number((this.cfg as any).chunk_size) * 1024 * 1024
      : 5 * 1024 * 1024;
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    let buf = new Uint8Array(0);
    let start = 0;
    const uploadPart = async (data: Uint8Array) => {
      const r = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Range": `bytes ${start}-${start + data.length - 1}/${size}`,
        },
        body: data,
      });
      if (r.status !== 200 && r.status !== 201 && r.status !== 202) {
        const txt = await r.text().catch(() => "");
        throw new Error(`onedrive_app 分片上传失败 ${r.status}: ${txt}`);
      }
      start += data.length;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf, 0);
      merged.set(value, buf.length);
      buf = merged;
      while (buf.length >= chunk) {
        await uploadPart(buf.slice(0, chunk));
        buf = buf.slice(chunk);
      }
    }
    if (buf.length > 0) await uploadPart(buf);
  }

  async mkdir(path: string): Promise<void> {
    const parent = parentPath(path);
    const url = parent === "/" ? `${this.metaUrl("/")}/children` : `${this.metaUrl(parent)}/children`;
    await this.jsonPost(url, {
      name: basename(path),
      folder: {},
      "@microsoft.graph.conflictBehavior": "rename",
    });
  }

  async remove(path: string): Promise<void> {
    await this.req(this.metaUrl(path), "DELETE");
  }

  private async itemId(p: string): Promise<string> {
    if (p === "/") return "root";
    const it = await this.jsonGet<any>(this.metaUrl(p));
    return it.id;
  }

  async rename(from: string, to: string): Promise<void> {
    const parentId = await this.itemId(parentPath(from));
    await this.req(
      this.metaUrl(from),
      "PATCH",
      JSON.stringify({ parentReference: { id: parentId }, name: basename(to) }),
      { "Content-Type": "application/json" }
    );
  }

  async move(from: string, to: string): Promise<void> {
    const dstParentId = await this.itemId(parentPath(to));
    await this.req(
      this.metaUrl(from),
      "PATCH",
      JSON.stringify({ parentReference: { id: dstParentId }, name: basename(to) }),
      { "Content-Type": "application/json" }
    );
  }
}

export type _Avoid = Env | DriverConfig;
