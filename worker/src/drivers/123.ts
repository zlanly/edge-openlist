import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";
import { md5Hex } from "../util/md5";

const MAIN = "https://yun.123pan.com/b/api";
const LOGIN = "https://login.123pan.com/api/user/sign_in";
const TABLE = ["a","d","e","f","g","h","l","m","y","i","j","n","o","p","k","q","r","s","t","u","b","c","v","w","s","z"];

// 123 网盘（用户名/密码登录，Bearer + CRC32 签名）。端点来自 OpenList drivers/123。
export class Pan123Driver extends CloudBase {
  readonly id = "123";
  private token = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  // ---- CRC32(ISO-HDLC/IEEE) ----
  private crc32(bytes: Uint8Array): number {
    let crc = ~0 >>> 0;
    for (let i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
    }
    return (~crc) >>> 0;
  }

  private signPath(pathname: string, os: string, version: string): [string, string] {
    const random = String(Math.round(1e7 * Math.random()));
    const now = new Date(Date.now() + 8 * 3600 * 1000); // CST UTC+8
    const timestamp = String(Math.floor(now.getTime() / 1000));
    let nowStr = now.toISOString().slice(0, 13).replace(/[-:T]/g, "").slice(0, 12); // YYYYMMDDHHmm
    const nowBytes = new Uint8Array(nowStr.length);
    for (let i = 0; i < nowStr.length; i++) nowBytes[i] = TABLE[nowStr.charCodeAt(i) - 48].charCodeAt(0);
    const timeSign = String(this.crc32(nowBytes));
    const data = [timestamp, random, pathname, os, version, timeSign].join("|");
    const dataSign = String(this.crc32(new TextEncoder().encode(data)));
    return [timeSign, `${timestamp}-${random}-${dataSign}`];
  }

  private getApi(url: string): string {
    const u = new URL(url);
    const [k, v] = this.signPath(u.pathname, "web", "3");
    u.searchParams.set(k, v);
    return u.toString();
  }

  private async login(): Promise<void> {
    const user = this.cfgStr("username");
    const pass = this.cfgStr("password");
    const body = user.includes("@")
      ? { mail: user, password: pass, type: 2 }
      : { passport: user, password: pass, remember: true };
    const r = await fetch(LOGIN, {
      method: "POST",
      headers: { origin: "https://yun.123pan.com", referer: "https://yun.123pan.com/", "user-agent": "Dart/2.19(dart:io)-openlist", platform: "web", "app-version": "3" },
      body: JSON.stringify(body),
    });
    const j = (await r.json()) as any;
    if (j.code !== 200) throw new Error(`123: 登录失败 ${j.message}`);
    this.token = j.data.token;
    await saveTokens(this.env.KV, this.mountId, { access_token: this.token, refresh_token: "", expires_at: Date.now() + 30 * 86400 * 1000 });
  }

  protected async hdrs(): Promise<Record<string, string>> {
    if (!this.token || isExpired(await loadTokens(this.env.KV, this.mountId))) {
      await this.login();
    }
    return {
      origin: "https://yun.123pan.com",
      referer: "https://yun.123pan.com/",
      authorization: "Bearer " + this.token,
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) openlist-client",
      platform: this.cfgStr("platform") || "web",
      "app-version": "3",
    };
  }

  private async api<T>(pathname: string, params: Record<string, string>, method = "GET", body?: unknown, retried = false): Promise<T> {
    const h = await this.hdrs();
    const url = new URL(this.getApi(`${MAIN}${pathname}`));
    if (method === "GET") {
      for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
    }
    const r = await fetch(url.toString(), {
      method,
      headers: { "Content-Type": "application/json", ...h },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = (await r.json()) as any;
    if (j.code === 401) {
      if (retried) throw new Error(`123: ${j.message || "认证失败"}`);
      this.token = "";
      await this.login();
      return this.api<T>(pathname, params, method, body, true);
    }
    if (j.code !== 0) throw new Error(`123: ${j.message}`);
    return j as T;
  }

  private async resolveId(path: string): Promise<string> {
    if (path === "/") return "0";
    let pdir = "0";
    for (const seg of path.split("/").filter(Boolean)) {
      const j = await this.api<{ data: { InfoList: any[]; Next: string; Total: number } }>("/file/list/new", {
        driveId: "0", limit: "100", next: "0", orderBy: "file_id", orderDirection: "desc",
        parentFileId: pdir, trashed: "false", SearchData: "", Page: "1", OnlyLookAbnormalFile: "0",
        event: "homeListFile", operateType: "4", inDirectSpace: "false",
      });
      const item = (j.data.InfoList || []).find((f) => f.FileName === seg);
      if (!item) throw new Error(`123: 路径不存在 ${path}`);
      pdir = String(item.FileId);
    }
    return pdir;
  }

  private toItem(f: any, base: string): FileItem {
    return {
      name: f.FileName,
      path: joinPath(base, f.FileName),
      is_dir: f.Type === 1,
      size: Number(f.Size || 0),
      modified: f.UpdateAt ? new Date(f.UpdateAt).getTime() : 0,
      etag: String(f.FileId), // 此处 etag 存 numeric FileId，供 move/rename/remove 使用
    };
  }

  // 取父目录 listing 中的完整对象（含 md5 Etag / S3KeyFlag，download_info 需要）
  private async statFull(path: string): Promise<any> {
    const base = path.split("/").slice(0, -1).join("/") || "/";
    const id = await this.resolveId(base);
    const j = await this.api<{ data: { InfoList: any[] } }>("/file/list/new", {
      driveId: "0", limit: "100", next: "0", orderBy: "file_id", orderDirection: "desc",
      parentFileId: id, trashed: "false", SearchData: "", Page: "1", OnlyLookAbnormalFile: "0",
      event: "homeListFile", operateType: "4", inDirectSpace: "false",
    });
    const name = path.split("/").pop();
    const f = (j.data.InfoList || []).find((x) => x.FileName === name);
    if (!f) throw new Error(`123: 不存在 ${path}`);
    return f;
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.resolveId(path);
    const out: FileItem[] = [];
    let page = 1;
    for (;;) {
      const j = await this.api<{ data: { InfoList: any[]; Next: string; Total: number } }>("/file/list/new", {
        driveId: "0", limit: "100", next: "0", orderBy: "file_id", orderDirection: "desc",
        parentFileId: id, trashed: "false", SearchData: "", Page: String(page), OnlyLookAbnormalFile: "0",
        event: "homeListFile", operateType: "4", inDirectSpace: "false",
      });
      for (const f of j.data.InfoList || []) out.push(this.toItem(f, path));
      if (!j.data.InfoList?.length || j.data.Next === "-1") break;
      page++;
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    if (path === "/") return { name: "", path: "/", is_dir: true, size: 0, modified: 0 };
    const parent = path.split("/").slice(0, -1).join("/") || "/";
    const id = await this.resolveId(parent);
    const j = await this.api<{ data: { InfoList: any[] } }>("/file/list/new", {
      driveId: "0", limit: "100", next: "0", orderBy: "file_id", orderDirection: "desc",
      parentFileId: id, trashed: "false", SearchData: "", Page: "1", OnlyLookAbnormalFile: "0",
      event: "homeListFile", operateType: "4", inDirectSpace: "false",
    });
    const name = path.split("/").pop();
    const f = (j.data.InfoList || []).find((x) => x.FileName === name);
    if (!f) throw new Error(`123: 不存在 ${path}`);
    return this.toItem(f, parent);
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const f = await this.statFull(path);
    const j = await this.api<{ data: { DownloadUrl: string } }>("/file/download_info", {}, "POST", {
      driveId: 0, etag: f.Etag, fileId: Number(f.FileId), fileName: f.FileName, s3keyFlag: f.S3KeyFlag, size: f.Size, type: f.Type,
    });
    let url = j.data.DownloadUrl;
    const pu = new URL(url);
    const params = pu.searchParams.get("params");
    if (params) {
      const dec = atob(params);
      const u2 = new URL(dec);
      u2.search = "";
      url = u2.toString();
    }
    return fetch(url, { headers: { Referer: "https://yun.123pan.com/", ...(range ? { Range: range } : {}) }, redirect: "follow" });
  }

  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(_path)}`, method: "PUT", headers: { "x-driver": "123" } };
  }

  // Worker 代理：S3 预签名分片直传（对应 OpenList newUpload + completeS3）
  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const parentId = await this.resolveId(path.split("/").slice(0, -1).join("/") || "/");
    const name = basename(path);
    const buf = new Uint8Array(await new Response(body).arrayBuffer());
    const etag = md5Hex(buf).toLowerCase();
    const req = await this.api<any>("/file/upload_request", {}, "POST", {
      driveId: 0, duplicate: 2, etag, fileName: name, parentFileId: Number(parentId), size: buf.length, type: 0,
    });
    if (req.data.reuse || !req.data.key) return; // 秒传
    const up = req.data;
    const chunkSize = 16 * 1024 * 1024;
    const chunkCount = Math.max(1, Math.ceil(buf.length / chunkSize));
    const lastChunk = buf.length % chunkSize || chunkSize;
    const endpoint = chunkCount > 1 ? "/file/s3_repare_upload_parts_batch" : "/file/s3_upload_object/auth";
    const start = 1, end = chunkCount + 1;
    const urls = await this.api<any>(endpoint, {}, "POST", {
      StorageNode: up.StorageNode, bucket: up.Bucket, key: up.Key, partNumberStart: start, partNumberEnd: end, uploadId: up.UploadId,
    });
    const map = urls.data.presignedUrls || urls.data.PreSignedUrls || {};
    for (let cur = 1; cur <= chunkCount; cur++) {
      const offset = (cur - 1) * chunkSize;
      const slice = buf.slice(offset, offset + (cur === chunkCount ? lastChunk : chunkSize));
      const u = map[String(cur)];
      if (!u) throw new Error(`123: 缺失分片 ${cur} 预签名`);
      const r = await fetch(u, { method: "PUT", headers: { "Content-Length": String(slice.length) }, body: slice });
      if (!r.ok) throw new Error(`123: 分片 ${cur} 上传失败 ${r.status}`);
    }
    await this.api("/file/upload_complete/v2", {}, "POST", {
      StorageNode: up.StorageNode, bucket: up.Bucket, fileId: up.FileId, fileSize: buf.length, isMultipart: chunkCount > 1, key: up.Key, uploadId: up.UploadId,
    });
  }

  async mkdir(path: string): Promise<void> {
    const parentId = await this.resolveId(path.split("/").slice(0, -1).join("/") || "/");
    await this.api("/file/upload_request", {}, "POST", { driveId: 0, etag: "", fileName: basename(path), parentFileId: Number(parentId), size: 0, type: 1 });
  }

  async remove(path: string): Promise<void> {
    const item = await this.get(path);
    await this.api("/file/trash", {}, "POST", { driveId: 0, operation: true, fileTrashInfoList: [{ FileId: Number(item.etag ? item.etag : 0), FileName: item.name, Size: item.size, Type: item.is_dir ? 1 : 0, Etag: item.etag }] });
  }

  async rename(from: string, to: string): Promise<void> {
    const item = await this.get(from);
    await this.api("/file/rename", {}, "POST", { driveId: 0, fileId: Number(item.etag || 0), fileName: basename(to) });
  }

  async move(from: string, to: string): Promise<void> {
    const item = await this.get(from);
    const dest = await this.resolveId(to.split("/").slice(0, -1).join("/") || "/");
    await this.api("/file/mod_pid", {}, "POST", { fileIdList: [{ FileId: Number(item.etag || 0) }], parentFileId: Number(dest) });
  }
}

// CRC32 标准表（IEEE 802.3）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export type _Avoid = Env | DriverConfig;
