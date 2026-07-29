import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";

const API = "https://api.aliyundrive.com/v2";
const AUTH = "https://auth.aliyundrive.com/v2/account/token";
const CANARY = { "X-Canary": "client=web,app=adrive,version=v4.0.0" };

// 阿里云盘驱动（个人版 API）
export class AliyunDriveDriver extends CloudBase {
  readonly id = "aliyun";
  private driveId = "";
  private accessToken = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  private async ensureToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    let t = await loadTokens(this.env.KV, this.mountId);
    if (isExpired(t)) {
      const rt = this.cfgStr("refreshToken") || t?.refresh_token || "";
      if (!rt) throw new Error("缺少 refresh_token");
      const r = await fetch(AUTH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: rt }),
      });
      if (!r.ok) throw new Error(`阿里云盘令牌刷新失败 ${r.status}`);
      const j = (await r.json()) as any;
      t = {
        access_token: j.access_token,
        refresh_token: j.refresh_token || rt,
        expires_at: Date.now() + (Number(j.expires_in) || 7200) * 1000,
        extra: j,
      };
      await saveTokens(this.env.KV, this.mountId, t);
    }
    this.driveId = (t!.extra?.default_drive_id as string) || this.cfgStr("driveId") || "";
    this.accessToken = t!.access_token;
    return this.accessToken;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.ensureToken()}`, ...CANARY };
  }

  private async resolveId(path: string): Promise<string> {
    if (path === "/") return "root";
    const j = await this.jsonPost<{ file_id: string }>(`${API}/v2/file/get_by_path`, {
      drive_id: this.driveId,
      file_path: path,
      fields: "*",
    });
    return j.file_id;
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.resolveId(path);
    const j = await this.jsonPost<{ items: any[] }>(`${API}/v2/file/list`, {
      drive_id: this.driveId,
      parent_file_id: id,
      limit: 100,
      order_by: "name",
      order_direction: "ASC",
      fields: "*",
      marker: "",
    });
    return (j.items || []).map((it) => ({
      name: it.name,
      path: joinPath(path, it.name),
      is_dir: it.type === "folder",
      size: Number(it.size || 0),
      modified: it.updated_at ? Date.parse(it.updated_at) : 0,
      etag: it.file_id,
    }));
  }

  async get(path: string): Promise<FileItem> {
    const id = await this.resolveId(path);
    const it = await this.jsonPost<any>(`${API}/v2/file/get_by_path`, { drive_id: this.driveId, file_path: path, fields: "*" });
    return {
      name: basename(path),
      path,
      is_dir: it.type === "folder",
      size: Number(it.size || 0),
      modified: it.updated_at ? Date.parse(it.updated_at) : 0,
    };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const id = await this.resolveId(path);
    const j = await this.jsonPost<{ url: string }>(`${API}/v2/file/get_download_url`, {
      drive_id: this.driveId,
      file_id: id,
      expire_sec: 600,
    });
    return fetch(j.url, range ? { headers: { Range: range } } : {});
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    // 阿里云盘无简单预签名直传，走 Worker 代理分片上传
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "aliyun" } };
  }

  // Worker 代理分片上传（流式逐片 PUT，避免整文件缓冲）
  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const token = await this.ensureToken();
    const parentId = await this.resolveId(parentPath(path));
    const name = basename(path);
    const partSize = 8 * 1024 * 1024;
    const create = await this.jsonPost<any>(`${API}/v2/file/create`, {
      drive_id: this.driveId,
      parent_file_id: parentId,
      name,
      type: "file",
      size,
      content_hash_name: "sha1",
      content_hash: "",
      check_name_mode: "auto_rename",
      upload_type: "UPLOAD_URL",
      upload_id: "",
      proof_version: "v1",
      proof_code: "",
    });
    if (create.existence || !create.part_info_list?.length) return; // 秒传命中
    const fileId = create.file_id;
    const uploadId = create.upload_id;
    const parts: any[] = create.part_info_list;
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    let buf = new Uint8Array(0);
    let partNo = 1;
    const uploadPart = async (data: Uint8Array) => {
      const part = parts.find((p) => p.part_number === partNo) || parts[partNo - 1];
      if (!part) throw new Error(`缺少分片 ${partNo} 上传地址`);
      const r = await fetch(part.upload_url, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(data.length) },
        body: data,
      });
      if (!r.ok) throw new Error(`分片上传失败 ${r.status}`);
      partNo++;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf, 0);
      merged.set(value, buf.length);
      buf = merged;
      while (buf.length >= partSize) {
        await uploadPart(buf.slice(0, partSize));
        buf = buf.slice(partSize);
      }
    }
    if (buf.length > 0) await uploadPart(buf);
    await this.jsonPost(`${API}/v2/file/complete`, { drive_id: this.driveId, file_id: fileId, upload_id: uploadId });
  }

  async mkdir(path: string): Promise<void> {
    const parentId = await this.resolveId(parentPath(path));
    await this.jsonPost(`${API}/v2/file/create_folder`, {
      drive_id: this.driveId,
      parent_file_id: parentId,
      name: basename(path),
      check_name_mode: "auto_rename",
    });
  }

  async remove(path: string): Promise<void> {
    const id = await this.resolveId(path);
    await this.jsonPost(`${API}/v2/recyclebin/create`, { drive_id: this.driveId, file_id: id });
  }

  async rename(from: string, to: string): Promise<void> {
    const id = await this.resolveId(from);
    await this.jsonPost(`${API}/v2/file/update`, { drive_id: this.driveId, file_id: id, name: basename(to) });
  }

  async move(from: string, to: string): Promise<void> {
    const fileId = await this.resolveId(from);
    const destId = await this.resolveId(parentPath(to));
    await this.jsonPost(`${API}/v2/file/move`, { drive_id: this.driveId, file_id: fileId, to_parent_file_id: destId, new_name: basename(to), check_name_mode: "refuse" });
  }
}

export type _Avoid = Env | DriverConfig;
