import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath } from "./base";
import { CloudBase } from "./cloud-base";

const API = "https://photo.baidu.com/youai";
const USER = API + "/user/v1";
const ALBUM = API + "/album/v1";
const FILE_V1 = API + "/file/v1";
const FILE_V2 = API + "/file/v2";

// 百度网盘相册（OpenList 源码核对：drivers/baidu_photo/{driver.go,util.go,types.go}）
// 认证：Cookie。路径编码 ID：目录="/a/<albumId>/<title>" 文件="/f/<fsid>/<name>"
function enc(kind: "a" | "f", id: string, name: string): string {
  return joinPath("/" + kind + "/" + id, name);
}
function dec(p: string): { kind: string; id: string; name: string } {
  const s = normalizePath(p).split("/");
  return { kind: s[1], id: s[2], name: s.slice(3).join("/") };
}

export class BaiduPhotoDriver extends CloudBase {
  readonly id = "baidu_photo";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Cookie: this.cfgStr("cookie") };
  }

  private async getJ(url: string, q: Record<string, string> = {}): Promise<any> {
    const r = await fetch(url + "?" + new URLSearchParams(q), { headers: await this.hdrs() });
    if (!r.ok) throw new Error(`GET ${r.status} ${url}`);
    const j = (await r.json()) as any;
    if (j.errno && j.errno !== 0) throw new Error(`baidu_photo errno ${j.errno}`);
    return j;
  }

  private async postJ(url: string, data: Record<string, string>): Promise<any> {
    const r = await fetch(url, {
      method: "POST",
      headers: { ...(await this.hdrs()), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(data),
    });
    if (!r.ok) throw new Error(`POST ${r.status} ${url}`);
    const j = (await r.json()) as any;
    if (j.errno && j.errno !== 0) throw new Error(`baidu_photo errno ${j.errno}`);
    return j;
  }

  private nextCursor(j: any, current: string): string | undefined {
    const next = j.next_cursor ?? j.cursor ?? j.nextCursor;
    if (next == null || String(next) === "" || String(next) === current) return undefined;
    if (j.has_more === false || j.hasMore === false) return undefined;
    return String(next);
  }

  async list(path: string): Promise<FileItem[]> {
    const d = dec(path);
    if (d.kind === "a") {
      // 相册内文件
      const out: FileItem[] = [];
      let cursor = "";
      for (;;) {
        const j = await this.getJ(ALBUM + "/listfile", { album_id: d.id, need_amount: "1", limit: "1000", passwd: "", cursor });
        for (const f of j.list || []) {
          out.push({ name: f.server_filename || f.name, path: enc("f", String(f.fsid), f.server_filename || f.name), is_dir: false, size: f.size || 0, modified: (f.mtime || f.uptime || 0) * 1000 });
        }
        const next = this.nextCursor(j, cursor);
        if (!next) return out;
        cursor = next;
      }
    }
    // 根：相册 + 文件
    const out: FileItem[] = [];
    let cursor = "";
    for (;;) {
      const al = await this.getJ(ALBUM + "/list", { need_amount: "1", limit: "100", cursor });
      for (const a of al.list || []) {
        out.push({ name: a.title, path: enc("a", a.album_id, a.title), is_dir: true, size: 0, modified: (a.mtime || 0) * 1000 });
      }
      const next = this.nextCursor(al, cursor);
      if (!next) break;
      cursor = next;
    }
    cursor = "";
    for (;;) {
      const fl = await this.getJ(FILE_V1 + "/list", { need_thumbnail: "1", need_filter_hidden: "0", cursor });
      for (const f of fl.list || []) {
        const name = f.path ? f.path.split("/").pop() : String(f.fsid);
        out.push({ name, path: enc("f", String(f.fsid), name), is_dir: false, size: f.size || 0, modified: (f.mtime || 0) * 1000 });
      }
      const next = this.nextCursor(fl, cursor);
      if (!next) break;
      cursor = next;
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    const d = dec(path);
    if (d.kind === "a") return { name: d.name, path, is_dir: true, size: 0, modified: 0 };
    const j = await this.getJ(FILE_V2 + "/download", { fsid: d.id });
    if (!j.dlink) throw new Error(`文件不存在或无法下载: ${path}`);
    return { name: d.name, path, is_dir: false, size: 0, modified: 0 };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const d = dec(path);
    const j = await this.getJ(FILE_V2 + "/download", { fsid: d.id });
    if (!j.dlink) throw new Error("no dlink");
    return fetch(j.dlink, { headers: { "User-Agent": "pan.baidu.com", Referer: "https://photo.baidu.com/", ...(range ? { Range: range } : {}) } });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "baidu_photo" } };
  }

  async putContent(): Promise<void> {
    // 相册上传需 MD5（Web Crypto 无 MD5），走代理；见报告
    throw new Error("baidu_photo 上传需要 MD5，未实现");
  }

  async mkdir(path: string): Promise<void> {
    const d = dec(parentPathOf(path));
    if (d.kind !== "" && parentPathOf(path) !== "/") throw new Error("仅根目录可建相册");
    const name = basename(path);
    await this.getJ(ALBUM + "/create", { title: name, tid: Date.now().toString(), source: "0" });
  }

  async remove(path: string): Promise<void> {
    const d = dec(path);
    if (d.kind === "f") {
      await this.getJ(FILE_V1 + "/delete", { fsid_list: `[${d.id}]` });
    } else {
      await this.postJ(ALBUM + "/delete", { album_id: d.id, tid: "0", delete_origin_image: "0" });
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const d = dec(from);
    if (d.kind !== "a") throw new Error("仅相册可改名");
    await this.postJ(ALBUM + "/settitle", { title: basename(to), album_id: d.id, tid: "0" });
  }

  async move(): Promise<void> {
    throw new Error("baidu_photo 不支持 move");
  }
}

function parentPathOf(p: string): string {
  const s = normalizePath(p);
  if (s === "/") return "/";
  const i = s.lastIndexOf("/");
  return i <= 0 ? "/" : s.slice(0, i);
}
