// MediaFire（Cookie + session_token + action_token）。端点移植自 OpenList drivers/mediafire/*。
// 上传注意：上游 resumable 上传要求每片 SHA256（x-unit-hash），须先整段读入计算哈希，
// 因此 putContent 会缓冲整文件（中等体积可接受）。大文件直传建议走原生 OpenList 服务端。
import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";

const APP = "https://app.mediafire.com";
const API = "https://www.mediafire.com/api/1.5";
const HOST = "https://www.mediafire.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36";

export class MediaFireDriver extends CloudBase {
  readonly id = "mediafire";
  private cookie = "";
  private sessionToken = "";
  private actionToken = "";
  private pathKeys: Record<string, string> = {};
  private orderBy = "name";
  private orderDir = "asc";
  private chunkSize = 100;

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.cookie = this.cfgStr("cookie") || "";
    if (!this.cookie) throw new Error("MediaFire 缺少 cookie");
    this.sessionToken = this.cfgStr("session_token") || "";
    this.orderBy = this.cfgStr("order_by") || "name";
    this.orderDir = this.cfgStr("order_direction") || "asc";
    this.chunkSize = Number(this.cfgStr("chunk_size")) || 100;
    if (this.sessionToken) {
      try {
        await this.getSessionToken();
      } catch {
        await this.renewToken();
      }
    } else {
      await this.getSessionToken();
    }
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  private async getSessionToken(): Promise<void> {
    const r = await fetch(HOST + "/application/get_session_token.php", {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Content-Length": "0",
        Cookie: this.cookie,
        Origin: HOST,
        Referer: HOST + "/",
        "User-Agent": UA,
      },
    });
    const body = await r.text();
    const j = JSON.parse(body) as any;
    const st = j?.response?.session_token;
    if (!st) throw new Error("MediaFire 获取 session_token 失败");
    this.sessionToken = st;
    const setC = r.headers.get("set-cookie") || "";
    if (setC) this.cookie = setC.split(",").map((c) => c.trim().split(";")[0]).join("; ");
  }

  private async renewToken(): Promise<void> {
    const j = await this.postForm<any>("/user/new_session_token.php", {
      session_token: this.sessionToken,
      response_format: "json",
    });
    if (j?.response?.result !== "Success") throw new Error("MediaFire token 续期失败");
    this.sessionToken = j.response.session_token;
  }

  private async postForm<T>(endpoint: string, data: Record<string, string>): Promise<T> {
    const fd = new URLSearchParams();
    for (const [k, v] of Object.entries(data)) fd.set(k, v);
    const r = await fetch(API + endpoint, {
      method: "POST",
      headers: {
        Cookie: this.cookie,
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: APP,
        Referer: APP + "/",
        "User-Agent": UA,
      },
      body: fd.toString(),
    });
    const j = (await r.json()) as any;
    if (j?.response?.result && j.response.result !== "Success")
      throw new Error(`MediaFire API 错误: ${j.response.result}`);
    return j as T;
  }

  private async getForm<T>(endpoint: string, data: Record<string, string>): Promise<T> {
    const u = new URL(API + endpoint);
    for (const [k, v] of Object.entries(data)) u.searchParams.set(k, v);
    const r = await fetch(u.toString(), {
      method: "GET",
      headers: { Cookie: this.cookie, Origin: APP, Referer: APP + "/", "User-Agent": UA },
    });
    const j = (await r.json()) as any;
    if (j?.response?.result && j.response.result !== "Success")
      throw new Error(`MediaFire API 错误: ${j.response.result}`);
    return j as T;
  }

  private checkFolderKey(path: string): string {
    // MediaFire 用 folder_key 做定位；根目录为 ""
    return this.parentKey(path);
  }

  private async getFiles(folderKey: string): Promise<FileItem[]> {
    const out: FileItem[] = [];
    let chunk = 1;
    for (;;) {
      const fr = await this.getForm<any>("/folder/get_content.php", {
        session_token: this.sessionToken,
        response_format: "json",
        folder_key: folderKey,
        content_type: "folders",
        chunk: String(chunk),
        chunk_size: String(this.chunkSize),
        details: "yes",
        order_direction: this.orderDir,
        order_by: this.orderBy,
        filter: "",
      });
      const fdr = fr?.response?.folder_content;
      const fc = await this.getForm<any>("/folder/get_content.php", {
        session_token: this.sessionToken,
        response_format: "json",
        folder_key: folderKey,
        content_type: "files",
        chunk: String(chunk),
        chunk_size: String(this.chunkSize),
        details: "yes",
        order_direction: this.orderDir,
        order_by: this.orderBy,
        filter: "",
      });
      const fic = fc?.response?.folder_content;
      for (const f of fdr?.folders || []) {
        out.push({ name: f.name, path: joinPath(this.pathCache, f.name), is_dir: true, size: 0, modified: f.created_utc ? Date.parse(f.created_utc) : 0, etag: f.folderkey });
      }
      for (const f of fic?.files || []) {
        out.push({ name: f.filename, path: joinPath(this.pathCache, f.filename), is_dir: false, size: Number(f.size || 0), modified: f.created_utc ? Date.parse(f.created_utc) : 0, etag: f.quickkey });
      }
      if (fdr?.more_chunks !== "yes" && fic?.more_chunks !== "yes") break;
      chunk++;
    }
    return out;
  }

  // pathCache 用于给 list 结果拼相对路径（MediaFire 只返回 folder_key）
  private pathCache = "/";

  async list(path: string): Promise<FileItem[]> {
    this.pathCache = path;
    const key = this.parentKey(path);
    const items = await this.getFiles(key);
    for (const it of items) if (it.is_dir && it.etag) this.pathKeys[it.path] = it.etag;
    return items;
  }

  private parentKey(path: string): string {
    const p = parentPath(path);
    return p === "/" ? "" : (this.pathKeys[p] || "");
  }

  async get(path: string): Promise<FileItem> {
    const items = await this.list(parentPath(path));
    const it = items.find((i) => i.path === path);
    if (!it) throw new Error("not found: " + path);
    return it;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const items = await this.list(parentPath(path));
    const it = items.find((i) => i.path === path);
    if (!it) throw new Error("not found: " + path);
    const j = await this.getForm<any>("/file/get_links.php", {
      session_token: this.sessionToken,
      quick_key: it.etag || "",
      link_type: "direct_download",
      response_format: "json",
    });
    const links = j?.response?.links || [];
    if (!links.length) throw new Error("MediaFire 无下载链接");
    const url = links[0].direct_download;
    const h: Record<string, string> = { Origin: APP, Referer: APP + "/" };
    if (range) h["Range"] = range;
    return fetch(url, { headers: h });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "mediafire" } };
  }

  // 缓冲整文件以满足上游 SHA256 分片哈希要求（见文件头注释）
  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const parentItems = await this.getFiles(this.parentKey(parentPath(path)));
    const parentIt = parentItems.find((i) => i.path === parentPath(path));
    const folderKey = parentIt?.etag || "";
    const buf = new Uint8Array(size || 8 * 1024 * 1024);
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    let off = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) { buf.set(value, off); off += value.length; }
    }
    const hashBuf = buf.slice(0, off);
    const dig = await crypto.subtle.digest("SHA-256", hashBuf);
    const fileHash = [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");

    const check = await this.postForm<any>("/upload/check.php", {
      session_token: await this.getActionToken(),
      filename: basename(path),
      size: String(off),
      hash: fileHash,
      folder_key: folderKey,
      resumable: "yes",
      response_format: "json",
    });
    if (check?.response?.hash_exists === "yes" && check?.response?.in_account === "yes") return;
    let pollKey = check?.response?.resumable_upload?.upload_key;
    if (check?.response?.resumable_upload?.all_units_ready !== "yes") {
      pollKey = await this.uploadUnit(hashBuf, fileHash, basename(path), off, folderKey, check);
    }
    await this.postForm<any>("/upload/poll_upload.php", {
      key: pollKey,
      response_format: "json",
      session_token: await this.getActionToken(),
    });
  }

  private async uploadUnit(data: Uint8Array, fileHash: string, filename: string, size: number, folderKey: string, check: any): Promise<string> {
    const uploadKey = check?.response?.resumable_upload?.upload_key;
    const u = new URL(API + "/upload/resumable.php");
    u.searchParams.set("folder_key", folderKey);
    u.searchParams.set("response_format", "json");
    u.searchParams.set("session_token", await this.getActionToken());
    u.searchParams.set("key", uploadKey);
    const unitHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const r = await fetch(u.toString(), {
      method: "POST",
      headers: {
        Cookie: this.cookie,
        Origin: APP,
        Referer: APP + "/",
        "User-Agent": UA,
        "Content-Type": "application/octet-stream",
        "x-filehash": fileHash,
        "x-filesize": String(size),
        "x-unit-id": "0",
        "x-unit-size": String(size),
        "x-unit-hash": unitHash,
        "x-filename": filename,
      },
      body: data,
    });
    const j = (await r.json()) as any;
    return j?.response?.doupload?.key;
  }

  private async getActionToken(): Promise<string> {
    if (this.actionToken) return this.actionToken;
    const j = await this.postForm<any>("/user/get_action_token.php", {
      type: "upload",
      lifespan: "1440",
      response_format: "json",
      session_token: this.sessionToken,
    });
    if (j?.response?.result !== "Success") throw new Error("MediaFire action token 失败");
    this.actionToken = j.response.action_token;
    return this.actionToken;
  }

  async mkdir(path: string): Promise<void> {
    const parentItems = await this.getFiles(this.parentKey(parentPath(path)));
    const parentIt = parentItems.find((i) => i.path === parentPath(path));
    await this.postForm("/folder/create.php", {
      session_token: this.sessionToken,
      response_format: "json",
      parent_key: parentIt?.etag || "",
      foldername: basename(path),
    });
  }

  async remove(path: string): Promise<void> {
    const it = (await this.list(parentPath(path))).find((i) => i.path === path);
    if (!it) throw new Error("not found: " + path);
    if (it.is_dir) {
      await this.postForm("/folder/delete.php", { session_token: this.sessionToken, response_format: "json", folder_key: it.etag || "" });
    } else {
      await this.postForm("/file/delete.php", { session_token: this.sessionToken, response_format: "json", quick_key: it.etag || "" });
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const it = (await this.list(parentPath(from))).find((i) => i.path === from);
    if (!it) throw new Error("not found: " + from);
    if (it.is_dir) {
      await this.postForm("/folder/update.php", { session_token: this.sessionToken, response_format: "json", folder_key: it.etag || "", foldername: basename(to) });
    } else {
      await this.postForm("/file/update.php", { session_token: this.sessionToken, response_format: "json", quick_key: it.etag || "", filename: basename(to) });
    }
  }

  async move(from: string, to: string): Promise<void> {
    const it = (await this.list(parentPath(from))).find((i) => i.path === from);
    const dstItems = await this.getFiles(this.parentKey(parentPath(to)));
    const dstIt = dstItems.find((i) => i.path === parentPath(to));
    if (!it) throw new Error("not found: " + from);
    if (it.is_dir) {
      await this.postForm("/folder/move.php", { session_token: this.sessionToken, response_format: "json", folder_key_src: it.etag || "", folder_key_dst: dstIt?.etag || "" });
    } else {
      await this.postForm("/file/move.php", { session_token: this.sessionToken, response_format: "json", quick_key: it.etag || "", folder_key: dstIt?.etag || "" });
    }
  }
}

export type _Avoid = Env | DriverConfig;
