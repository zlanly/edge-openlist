import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";
import { buildMultipart } from "./multipart";
import { sha1Hex } from "./signing";

// Degoo（GraphQL API + S3 分段上传）。端点/参数按 OpenList drivers/degoo 移植。
// 注意：上传 API 要求 SHA1(种子+全文) 校验和，需读取整文件，故此驱动 putContent 会缓冲
// 整文件（与上游 CacheFullAndWriter 行为一致，无法在流式下计算全文校验和）。
const LOGIN_URL = "https://rest-api.degoo.com/login";
const TOKEN_URL = "https://rest-api.degoo.com/access-token/v2";
const GQL_URL = "https://production-appsync.degoo.com/graphql";
const API_KEY = "da2-vs6twz5vnjdavpqndtbzg3prra";
const FOLDER_CHECKSUM = "CgAQAg";
const SEED = new Uint8Array([13, 7, 2, 2, 15, 40, 75, 117, 13, 10, 19, 16, 29, 23, 3, 36]);

export class DegooDriver extends CloudBase {
  readonly id = "degoo";
  private accessToken = "";
  private refreshToken = "";
  private rootId = "0";
  private pathToId = new Map<string, string>([["/", "0"]]);

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    const t = await loadTokens(this.env.KV, this.mountId);
    if (t?.access_token) {
      this.accessToken = t.access_token;
      this.refreshToken = t.refresh_token || "";
    } else {
      this.accessToken = this.cfgStr("access_token") || "";
      this.refreshToken = this.cfgStr("refresh_token") || "";
    }
    await this.ensureValidToken();
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  private async saveTok(): Promise<void> {
    const t: TokenSet = { access_token: this.accessToken, refresh_token: this.refreshToken, expires_at: this.jwtExp(this.accessToken) };
    await saveTokens(this.env.KV, this.mountId, t);
  }

  private jwtExp(tok: string): number {
    try {
      const p = tok.split(".")[1];
      const json = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
      return (json.exp || Math.floor(Date.now() / 1000) + 3600) * 1000;
    } catch {
      return Date.now() + 3600 * 1000;
    }
  }

  private async ensureValidToken(): Promise<void> {
    if (this.accessToken && !isExpired({ access_token: this.accessToken, expires_at: this.jwtExp(this.accessToken) })) return;
    if (this.refreshToken) {
      const r = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ RefreshToken: this.refreshToken }),
      });
      if (r.ok) {
        const j = (await r.json()) as any;
        if (j.AccessToken) {
          this.accessToken = j.AccessToken;
          await this.saveTok();
          return;
        }
      }
    }
    if (this.cfgStr("username") && this.cfgStr("password")) await this.login();
  }

  private async login(): Promise<void> {
    const r = await fetch(LOGIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.degoo.com" },
      body: JSON.stringify({ GenerateToken: true, Username: this.cfgStr("username"), Password: this.cfgStr("password") }),
    });
    if (!r.ok) throw new Error(`Degoo 登录失败: ${r.status}`);
    const j = (await r.json()) as any;
    if (j.RefreshToken) {
      const tr = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ RefreshToken: j.RefreshToken }),
      });
      const tj = (await tr.json()) as any;
      this.accessToken = tj.AccessToken;
      this.refreshToken = j.RefreshToken;
    } else if (j.Token) {
      this.accessToken = j.Token;
    } else throw new Error("Degoo 登录失败：无 token");
    await this.saveTok();
  }

  private async apiCall(operation: string, query: string, variables: Record<string, any>): Promise<any> {
    await this.ensureValidToken();
    if (variables.Token !== undefined) variables.Token = this.accessToken;
    const r = await fetch(GQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY, Authorization: `Bearer ${this.accessToken}` },
      body: JSON.stringify({ operationName: operation, query, variables }),
    });
    if (!r.ok) throw new Error(`Degoo GraphQL 失败: ${r.status}`);
    const j = (await r.json()) as any;
    if (j.errors && j.errors.length) {
      const e = j.errors[0];
      if (e.ErrorType === "Unauthorized") {
        this.accessToken = "";
        await this.ensureValidToken();
        variables.Token = this.accessToken;
        return this.apiCall(operation, query, variables);
      }
      throw new Error(`Degoo GraphQL 错误: ${e.Message}`);
    }
    return j.data;
  }

  private async children(parentId: string): Promise<any[]> {
    const q = `query G($Token:String!$ParentID:String!$Limit:Int!$Order:Int){getFileChildren5(Token:$Token ParentID:$ParentID Limit:$Limit Order:$Order){Items{ID ParentID Name Category Size CreationTime LastModificationTime LastUploadTime FilePath IsInRecycleBin DeviceID}}} `;
    const data = await this.apiCall("G", q, { Token: this.accessToken, ParentID: parentId, Limit: 1000, Order: 3 });
    return data.getFileChildren5.Items as any[];
  }

  private async resolveId(path: string): Promise<string> {
    const p = normalizePath(path);
    if (this.pathToId.has(p)) return this.pathToId.get(p)!;
    const segs = p.split("/").filter(Boolean);
    let cur = "/";
    let id = this.pathToId.get("/")!;
    for (const seg of segs) {
      const items = await this.children(id);
      const f = items.find((i) => i.Name === seg && (i.Category === 1 || i.Category === 2 || i.Category === 10));
      if (!f) throw new Error(`Degoo 路径不存在: ${path}`);
      cur = joinPath(cur, seg);
      this.pathToId.set(cur, f.ID);
      id = f.ID;
    }
    return id;
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.resolveId(path);
    const items = await this.children(id);
    return items.map((it) => ({
      name: it.Name,
      path: joinPath(path, it.Name),
      is_dir: it.Category === 1 || it.Category === 2 || it.Category === 10,
      size: Number(it.Size || 0),
      modified: it.LastModificationTime ? Number(it.LastModificationTime) : 0,
    }));
  }

  async get(path: string): Promise<FileItem> {
    if (path === "/") return { name: "", path: "/", is_dir: true, size: 0, modified: 0 };
    const items = await this.children(await this.resolveId(parentPath(path)));
    const name = basename(path);
    const it = items.find((i) => i.Name === name);
    if (!it) throw new Error("文件不存在");
    return { name, path, is_dir: it.Category === 1 || it.Category === 2 || it.Category === 10, size: Number(it.Size || 0), modified: Number(it.LastModificationTime || 0) };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const id = await this.resolveId(path);
    const q = `query G($Token:String!$ID:IDType!){getOverlay4(Token:$Token ID:$ID){URL}}`;
    const data = await this.apiCall("G", q, { Token: this.accessToken, ID: { FileID: id } });
    const url = data.getOverlay4.URL;
    return fetch(url, range ? { headers: { Range: range } } : {});
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "degoo" } };
  }

  async putContent(path: string, stream: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const parentId = await this.resolveId(parentPath(path));
    const name = basename(path);
    // 缓冲整文件以计算校验和（Degoo API 强制要求）
    const bytes = new Uint8Array(await new Response(stream as any).arrayBuffer());
    const checksum = await this.checksum(bytes);
    const auth = await this.getBucketWriteAuth4(name, checksum, size, parentId);
    const a = auth.getBucketWriteAuth4[0].AuthData;
    const ext = name.includes(".") ? "." + name.split(".").pop() : "";
    const key = `${a.KeyPrefix}${ext}/${checksum}${ext}`;
    const fields: Record<string, string> = { key, acl: a.ACL, policy: a.PolicyBase64, signature: a.Signature };
    fields[a.AccessKey.Key] = a.AccessKey.Value;
    for (const ad of a.AdditionalBody) fields[ad.Key] = ad.Value;
    fields["Content-Type"] = "";
    const mp = buildMultipart(fields, { name: key, stream: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), contentType: "" });
    const up = await fetch(a.BaseURL, { method: "POST", headers: { "ngsw-bypass": "1", "Content-Type": mp.contentType }, body: mp.body });
    if (up.status !== 204) throw new Error(`Degoo 上传失败: ${up.status}`);
    const q = `mutation S($Token:String!$FileInfos:[FileInfoUpload3]!){setUploadFile3(Token:$Token FileInfos:$FileInfos)}`;
    await this.apiCall("S", q, {
      Token: this.accessToken,
      FileInfos: [{ Checksum: checksum, CreationTime: Date.now(), Name: name, ParentID: parentId, Size: String(size) }],
    });
  }

  private async checksum(data: Uint8Array): Promise<string> {
    const merged = new Uint8Array(SEED.length + data.length);
    merged.set(SEED, 0);
    merged.set(data, SEED.length);
    const h = await sha1Hex(merged);
    const cs = new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
    const out = new Uint8Array(2 + cs.length + 2);
    out[0] = 10;
    out[1] = cs.length;
    out.set(cs, 2);
    out[out.length - 2] = 16;
    out[out.length - 1] = 0;
    let s = "";
    for (let i = 0; i < out.length; i++) s += String.fromCharCode(out[i]);
    return btoa(s).replace(/\//g, "_");
  }

  private async getBucketWriteAuth4(name: string, checksum: string, size: number, parentId: string): Promise<any> {
    const q = `query G($Token:String!$ParentID:String!$StorageUploadInfos:[StorageUploadInfo2]){getBucketWriteAuth4(Token:$Token ParentID:$ParentID StorageUploadInfos:$StorageUploadInfos){AuthData{PolicyBase64 Signature BaseURL KeyPrefix ACL AccessKey{Key Value} AdditionalBody{Key Value}} Error}}`;
    const data = await this.apiCall("G", q, {
      Token: this.accessToken,
      ParentID: parentId,
      StorageUploadInfos: [{ FileName: name, Checksum: checksum, Size: String(size) }],
    });
    return data;
  }

  async mkdir(path: string): Promise<void> {
    const parentId = await this.resolveId(parentPath(path));
    const q = `mutation S($Token:String!$FileInfos:[FileInfoUpload3]!){setUploadFile3(Token:$Token FileInfos:$FileInfos)}`;
    await this.apiCall("S", q, {
      Token: this.accessToken,
      FileInfos: [{ Checksum: FOLDER_CHECKSUM, Name: basename(path), CreationTime: Date.now(), ParentID: parentId, Size: "0" }],
    });
  }

  async remove(path: string): Promise<void> {
    const id = await this.resolveId(path);
    const q = `mutation S($Token:String!$IsInRecycleBin:Boolean!$IDs:[IDType]!){setDeleteFile5(Token:$Token IsInRecycleBin:$IsInRecycleBin IDs:$IDs)}`;
    await this.apiCall("S", q, { Token: this.accessToken, IsInRecycleBin: false, IDs: [{ FileID: id }] });
  }

  async rename(from: string, to: string): Promise<void> {
    const id = await this.resolveId(from);
    const q = `mutation S($Token:String!$FileRenames:[FileRenameInfo]!){setRenameFile(Token:$Token FileRenames:$FileRenames)}`;
    await this.apiCall("S", q, { Token: this.accessToken, FileRenames: [{ ID: id, NewName: basename(to) }] });
  }

  async move(from: string, to: string): Promise<void> {
    const id = await this.resolveId(from);
    const dstId = await this.resolveId(parentPath(to));
    const q = `mutation S($Token:String!$Copy:Boolean!$NewParentID:String!$FileIDs:[String]!){setMoveFile(Token:$Token Copy:$Copy NewParentID:$NewParentID FileIDs:$FileIDs)}`;
    await this.apiCall("S", q, { Token: this.accessToken, Copy: false, NewParentID: dstId, FileIDs: [id] });
  }
}
