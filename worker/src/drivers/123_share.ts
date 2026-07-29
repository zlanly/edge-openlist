import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath } from "./base";
import { CloudBase } from "./cloud-base";

const MAIN = "https://yun.123pan.com/b/api";
const TABLE = ["a","d","e","f","g","h","l","m","y","i","j","n","o","p","k","q","r","s","t","u","b","c","v","w","s","z"];

// 123 分享解析（提供 AccessToken + shareKey/sharePwd，CRC32 签名）。来自 OpenList drivers/123_share。
export class Pan123ShareDriver extends CloudBase {
  readonly id = "123_share";
  private token = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  private crc32(bytes: Uint8Array): number {
    let crc = ~0 >>> 0;
    for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
    return (~crc) >>> 0;
  }
  private signPath(pathname: string): [string, string] {
    const random = String(Math.round(1e7 * Math.random()));
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const nowStr = now.toISOString().slice(0, 13).replace(/[-:T]/g, "").slice(0, 12);
    const nb = new Uint8Array(nowStr.length);
    for (let i = 0; i < nowStr.length; i++) nb[i] = TABLE[nowStr.charCodeAt(i) - 48].charCodeAt(0);
    const timeSign = String(this.crc32(nb));
    const data = [timestamp, random, pathname, "web", "3", timeSign].join("|");
    const dataSign = String(this.crc32(new TextEncoder().encode(data)));
    return [timeSign, `${timestamp}-${random}-${dataSign}`];
  }
  private getApi(url: string): string {
    const u = new URL(url);
    const [k, v] = this.signPath(u.pathname);
    u.searchParams.set(k, v);
    return u.toString();
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {
      origin: "https://yun.123pan.com",
      referer: "https://yun.123pan.com/",
      authorization: "Bearer " + (this.token || this.cfgStr("AccessToken")),
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) openlist-client",
      platform: "web",
      "app-version": "3",
    };
  }

  private async api<T>(pathname: string, params: Record<string, string>, method = "GET", body?: unknown): Promise<T> {
    const h = await this.hdrs();
    const url = this.getApi(method === "GET" && params ? `${MAIN}${pathname}?${new URLSearchParams(params).toString()}` : `${MAIN}${pathname}`);
    const r = await fetch(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const j = (await r.json()) as any;
    if (j.code !== 0) throw new Error(`123_share: ${j.message}`);
    return j as T;
  }

  private async resolveId(path: string): Promise<string> {
    if (path === "/") return "0";
    let pdir = "0";
    for (const seg of path.split("/").filter(Boolean)) {
      let page = 1, found: any = null;
      for (;;) {
        const j = await this.api<{ data: { InfoList: any[]; Next: string } }>("/share/get", {
          limit: "100", next: "0", orderBy: "file_id", orderDirection: "desc", parentFileId: pdir,
          Page: String(page), shareKey: this.cfgStr("sharekey"), SharePwd: this.cfgStr("sharepassword"),
        });
        found = (j.data.InfoList || []).find((f) => f.FileName === seg) || found;
        if (found || j.data.Next === "-1" || (j.data.InfoList || []).length === 0) break;
        page++;
      }
      if (!found) throw new Error(`123_share: 路径不存在 ${path}`);
      pdir = String(found.FileId);
    }
    return pdir;
  }

  private async statFull(path: string): Promise<any> {
    const base = path.split("/").slice(0, -1).join("/") || "/";
    const id = await this.resolveId(base);
    let page = 1;
    for (;;) {
      const j = await this.api<{ data: { InfoList: any[]; Next: string } }>("/share/get", {
        limit: "100", next: "0", orderBy: "file_id", orderDirection: "desc", parentFileId: id,
        Page: String(page), shareKey: this.cfgStr("sharekey"), SharePwd: this.cfgStr("sharepassword"),
      });
      const f = (j.data.InfoList || []).find((x) => x.FileName === path.split("/").pop());
      if (f) return f;
      if (j.data.Next === "-1" || (j.data.InfoList || []).length === 0) break;
      page++;
    }
    throw new Error(`123_share: 不存在 ${path}`);
  }

  private toItem(f: any, base: string): FileItem {
    return {
      name: f.FileName,
      path: joinPath(base, f.FileName),
      is_dir: f.Type === 1,
      size: Number(f.Size || 0),
      modified: f.UpdateAt ? new Date(f.UpdateAt).getTime() : 0,
      etag: String(f.FileId),
    };
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.resolveId(path);
    const out: FileItem[] = [];
    let page = 1;
    for (;;) {
      const j = await this.api<{ data: { InfoList: any[]; Next: string } }>("/share/get", {
        limit: "100", next: "0", orderBy: "file_id", orderDirection: "desc", parentFileId: id,
        Page: String(page), shareKey: this.cfgStr("sharekey"), SharePwd: this.cfgStr("sharepassword"),
      });
      for (const f of j.data.InfoList || []) out.push(this.toItem(f, path));
      if (j.data.Next === "-1" || (j.data.InfoList || []).length === 0) break;
      page++;
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    const f = await this.statFull(path);
    return this.toItem(f, path.split("/").slice(0, -1).join("/") || "/");
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const f = await this.statFull(path);
    const j = await this.api<{ data: { DownloadURL: string } }>("/share/download/info", {}, "POST", {
      shareKey: this.cfgStr("sharekey"), SharePwd: this.cfgStr("sharepassword"),
      etag: f.Etag, fileId: Number(f.FileId), s3keyFlag: f.S3KeyFlag, size: f.Size,
    });
    let url = j.data.DownloadURL;
    const pu = new URL(url);
    const params = pu.searchParams.get("params");
    if (params) {
      const u2 = new URL(atob(params));
      u2.search = "";
      url = u2.toString();
    }
    return fetch(url, { headers: { Referer: "https://yun.123pan.com/", ...(range ? { Range: range } : {}) }, redirect: "follow" });
  }

  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    throw new Error("123_share: OpenList 标记 NoUpload，不支持上传");
  }
  async mkdir(_path: string): Promise<void> { throw new Error("123_share: 不支持（OpenList NotSupport）"); }
  async remove(_path: string): Promise<void> { throw new Error("123_share: 不支持（OpenList NotSupport）"); }
  async rename(_from: string, _to: string): Promise<void> { throw new Error("123_share: 不支持（OpenList NotSupport）"); }
  async move(_from: string, _to: string): Promise<void> { throw new Error("123_share: 不支持（OpenList NotSupport）"); }
}

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
