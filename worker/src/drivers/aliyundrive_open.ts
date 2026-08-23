import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";

const API = "https://openapi.alipan.com";
const CANARY = { "X-Canary": "client=web,app=adrive,version=v4.0.0" };

// 阿里云盘开放平台（OAuth，clientId/refreshToken）。端点与参数来自 OpenList drivers/aliyundrive_open。
export class AliyundriveOpenDriver extends CloudBase {
  readonly id = "aliyundrive_open";
  private accessToken = "";
  private driveId = "";

  private cfgStr(k: string): string {
    const value = (this.cfg as Record<string, unknown>)[k];
    return value == null ? "" : String(value);
  }

  private async refresh(): Promise<TokenSet> {
    const rt = this.cfgStr("refresh_token");
    if (!rt) throw new Error("缺少 refresh_token");
    const useOnline = (this.cfg as any).use_online_api !== false && this.cfgStr("api_url_address");
    let access = "", refresh = rt;
    if (useOnline) {
      const driverTxt = this.cfgStr("alipan_type") === "alipanTV" ? "alicloud_tv" : "alicloud_qr";
      const u = new URL(this.cfgStr("api_url_address"));
      u.searchParams.set("refresh_ui", rt);
      u.searchParams.set("server_use", "true");
      u.searchParams.set("driver_txt", driverTxt);
      const r = await fetch(u.toString());
      let j: any;
      try { j = await r.json(); } catch { throw new Error(`在线刷新失败: HTTP ${r.status}`); }
      if (!r.ok || !j.access_token || !j.refresh_token) throw new Error(`在线刷新失败: ${j?.text || j?.message || r.status}`);
      access = j.access_token;
      refresh = j.refresh_token;
      const expiresAt = Date.now() + (Number(j.expires_in) || 7200) * 1000;
      return { access_token: access, refresh_token: refresh, expires_at: expiresAt, extra: {} };
    } else {
      const cid = this.cfgStr("client_id");
      const csec = this.cfgStr("client_secret");
      if (!cid || !csec) throw new Error("缺少 client_id/client_secret");
      const r = await fetch(`${API}/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: cid, client_secret: csec, grant_type: "refresh_token", refresh_token: rt }),
      });
      const j = (await r.json()) as any;
      if (j.code) throw new Error(`刷新失败: ${j.message}`);
      access = j.access_token;
      refresh = j.refresh_token || rt;
    }
    return { access_token: access, refresh_token: refresh, expires_at: Date.now() + 7200 * 1000, extra: {} };
  }

  private async ensureToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    let t = await loadTokens(this.env.KV, this.mountId);
    if (isExpired(t)) {
      t = await this.refresh();
      await saveTokens(this.env.KV, this.mountId, t);
    }
    this.accessToken = t!.access_token;
    return this.accessToken;
  }

  private async ensureDrive(): Promise<void> {
    if (this.driveId) return;
    const tok = await this.ensureToken();
    const r = await fetch(`${API}/adrive/v1.0/user/getDriveInfo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
      body: "{}",
    });
    const j = (await r.json()) as any;
    if (j.code) throw new Error(`获取 drive 失败: ${j.message}`);
    const dt = this.cfgStr("drive_type") || "resource";
    this.driveId = j[`${dt}_drive_id`] || j.default_drive_id || j.resource_drive_id || "";
    if (!this.driveId) throw new Error(`未找到 ${dt} drive_id`);
  }

  protected async hdrs(): Promise<Record<string, string>> {
    const tok = await this.ensureToken();
    return { Authorization: `Bearer ${tok}`, ...CANARY };
  }

  private async api(uri: string, body: unknown, retried = false): Promise<any> {
    await this.ensureDrive();
    const r = await fetch(`${API}${uri}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await this.hdrs()) },
      body: JSON.stringify(body),
    });
    let j: any;
    try { j = await r.json(); } catch { throw new Error(`阿里云盘开放接口返回非法响应: HTTP ${r.status}`); }
    if (j.code === "AccessTokenInvalid" || j.code === "AccessTokenExpired" || j.code === "I400JD") {
      if (retried) throw new Error(`${j.code}: ${j.message || "令牌刷新后仍无效"}`);
      const t = await loadTokens(this.env.KV, this.mountId);
      if (t) await saveTokens(this.env.KV, this.mountId, { ...t, access_token: "", expires_at: 0 });
      this.accessToken = "";
      this.driveId = "";
      return this.api(uri, body, true);
    }
    if (!r.ok || j.code) throw new Error(`${j.code || `HTTP ${r.status}`}: ${j.message || "请求失败"}`);
    return j;
  }

  private async listChildren(parentId: string): Promise<any[]> {
    const items: any[] = [];
    let marker = "";
    do {
      const data = await this.api("/adrive/v1.0/openFile/list", {
        drive_id: this.driveId,
        limit: 200,
        marker,
        order_by: this.cfgStr("order_by") || "name",
        order_direction: this.cfgStr("order_direction") || "ASC",
        parent_file_id: parentId,
      });
      items.push(...(Array.isArray(data.items) ? data.items : []));
      const next = String(data.next_marker || "");
      if (!next || next === marker) break;
      marker = next;
    } while (marker);
    return items;
  }

  private async findChild(parentId: string, name: string, path: string): Promise<any> {
    const item = (await this.listChildren(parentId)).find((f: any) => f.name === name);
    if (!item) throw new Error(`路径不存在: ${path}`);
    return item;
  }

  private itemToFile(path: string, f: any): FileItem {
    return {
      name: f.name,
      path,
      is_dir: f.type === "folder",
      size: Number(f.size || 0),
      modified: f.updated_at ? Date.parse(f.updated_at) : 0,
      etag: f.file_id,
    };
  }

  private rootId(): string {
    return this.cfgStr("root_folder_id") || "root";
  }

  private async resolveId(path: string): Promise<string> {
    if (path === "/" || path === "") return this.rootId();
    const parts = normalizePath(path).split("/").filter(Boolean);
    let id = this.rootId();
    for (const name of parts) id = (await this.findChild(id, name, path)).file_id;
    return id;
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.resolveId(path);
    return (await this.listChildren(id)).map((f: any) => this.itemToFile(joinPath(path, f.name), f));
  }

  async get(path: string): Promise<FileItem> {
    if (path === "/") return { name: "", path: "/", is_dir: true, size: 0, modified: 0 };
    const parent = await this.resolveId(parentPath(path));
    const f = await this.findChild(parent, basename(path), path);
    return this.itemToFile(path, f);
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const id = await this.resolveId(path);
    const j = await this.api("/adrive/v1.0/openFile/getDownloadUrl", {
      drive_id: this.driveId,
      file_id: id,
      expire_sec: 14400,
    });
    const url = j.url;
    if (!url) throw new Error("获取下载链接失败");
    return fetch(url, range ? { headers: { Range: range } } : {});
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    // 无简单预签名直传，走 Worker 代理分片上传
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "aliyundrive_open" } };
  }

  // Worker 代理分片上传：边读边传，逐片 PUT 到 upload_url，不缓冲整文件
  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    await this.ensureDrive();
    const parentId = await this.resolveId(parentPath(path));
    const name = basename(path);
    // 开放平台默认分片为 20 MiB；4 MiB 分片会被接口拒绝，超大文件还会超过 10000 片上限。
    const minPartSize = 20 * 1024 * 1024;
    const partSize = Math.max(minPartSize, Math.ceil(Math.max(size, 1) / 10000));
    const count = Math.max(1, Math.ceil(size / partSize));
    const partInfoList = Array.from({ length: count }, (_, i) => ({ part_number: i + 1 }));
    const create = await this.api("/adrive/v1.0/openFile/create", {
      drive_id: this.driveId,
      parent_file_id: parentId,
      name,
      type: "file",
      check_name_mode: "ignore",
      size,
      part_info_list: partInfoList,
    });
    if (create.rapid_upload) {
      await this.api("/adrive/v1.0/openFile/complete", { drive_id: this.driveId, file_id: create.file_id, upload_id: create.upload_id });
      return;
    }
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    let buf = new Uint8Array(0);
    let received = 0;
    let partNo = 1;
    const uploadPart = async (data: Uint8Array, uploadUrl: string) => {
      const r = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(data.length) },
        body: data,
      });
      if (r.status !== 200 && r.status !== 409) throw new Error(`分片上传失败 ${r.status}`);
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf, 0);
        merged.set(value, buf.length);
        buf = merged;
        received += value.length;
        if (received > size) throw new Error("上传内容超过声明的文件大小");
        while (buf.length >= partSize) {
          if (partNo > count) throw new Error("上传内容超过声明的文件大小");
          const url = create.part_info_list[partNo - 1]?.upload_url;
          if (!url) throw new Error(`缺少第 ${partNo} 个分片上传地址`);
          await uploadPart(buf.slice(0, partSize), url);
          buf = buf.slice(partSize);
          partNo++;
        }
      }
      if (buf.length > 0) {
        if (partNo > count) throw new Error("上传内容超过声明的文件大小");
        const url = create.part_info_list[partNo - 1]?.upload_url;
        if (!url) throw new Error(`缺少第 ${partNo} 个分片上传地址`);
        await uploadPart(buf, url);
        partNo++;
      }
      if (partNo - 1 !== count) throw new Error(`上传内容不完整：期望 ${size} 字节，实际分片不足`);
    } finally {
      reader.releaseLock();
    }
    await this.api("/adrive/v1.0/openFile/complete", { drive_id: this.driveId, file_id: create.file_id, upload_id: create.upload_id });
  }

  async mkdir(path: string): Promise<void> {
    const parentId = await this.resolveId(parentPath(path));
    await this.api("/adrive/v1.0/openFile/create", {
      drive_id: this.driveId,
      parent_file_id: parentId,
      name: basename(path),
      type: "folder",
      check_name_mode: "refuse",
    });
  }

  async remove(path: string): Promise<void> {
    const id = await this.resolveId(path);
    const uri = (this.cfg as any).remove_way === "delete" ? "/adrive/v1.0/openFile/delete" : "/adrive/v1.0/openFile/recyclebin/trash";
    await this.api(uri, { drive_id: this.driveId, file_id: id });
  }

  async rename(from: string, to: string): Promise<void> {
    const id = await this.resolveId(from);
    await this.api("/adrive/v1.0/openFile/update", { drive_id: this.driveId, file_id: id, name: basename(to) });
  }

  async move(from: string, to: string): Promise<void> {
    const id = await this.resolveId(from);
    const destId = await this.resolveId(parentPath(to));
    await this.api("/adrive/v1.0/openFile/move", {
      drive_id: this.driveId,
      file_id: id,
      to_parent_file_id: destId,
      new_name: basename(to),
      check_name_mode: "ignore",
    });
  }
}

export type _Avoid = Env | DriverConfig;
