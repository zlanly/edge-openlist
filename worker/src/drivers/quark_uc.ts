import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens } from "../util/tokenstore";
import { md5Hex } from "../util/md5";

const API = "https://pc-api.uc.cn/1/clouddrive";
const REFERER = "https://drive.uc.cn";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) uc-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch";
const OSS_UA = "aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit";

// 夸克 UC 盘（cookie 登录态）。端点来自 OpenList drivers/quark_uc。
export class QuarkUCDriver extends CloudBase {
  readonly id = "quark_uc";
  private cooke0 = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    const c = this.cfgStr("cookie") || this.cooke0;
    return { Cookie: c, Accept: "application/json, text/plain, */*", Referer: REFERER };
  }

  private async apiReq<T>(pathname: string, params: Record<string, string>, method = "GET", body?: unknown): Promise<T> {
    const h = await this.hdrs();
    const q = new URLSearchParams({ pr: "UCBrowser", fr: "pc", ...params }).toString();
    const r = await fetch(`${API}${pathname}?${q}`, {
      method,
      headers: { "Content-Type": "application/json", ...h },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = (await r.json()) as any;
    if (j.status >= 400 || (j.code !== undefined && j.code !== 0)) throw new Error(`quark_uc: ${j.message || j.error_info}`);
    return j as T;
  }

  private async resolveId(path: string): Promise<string> {
    if (path === "/") return "0";
    let pdir = "0";
    for (const seg of path.split("/").filter(Boolean)) {
      let page = 1;
      let item: any;
      for (;;) {
        const j = await this.apiReq<{ data: { list: any[] }; metadata: { total: number } }>(
          "/file/sort",
          { pdir_fid: pdir, _size: "100", _fetch_total: "1", fetch_all_file: "1", _page: String(page) }
        );
        item = (j.data.list || []).find((f) => f.file_name === seg);
        if (item || page * 100 >= (j.metadata?.total || 0) || !(j.data.list || []).length) break;
        page++;
      }
      if (!item) throw new Error(`quark_uc: 路径不存在 ${path}`);
      pdir = item.fid;
    }
    return pdir;
  }

  private toItem(f: any, base: string): FileItem {
    return {
      name: f.file_name,
      path: joinPath(base, f.file_name),
      is_dir: !f.file,
      size: Number(f.size || 0),
      modified: f.updated_at ? Number(f.updated_at) : 0,
      etag: f.fid,
    };
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.resolveId(path);
    const out: FileItem[] = [];
    let page = 1;
    for (;;) {
      const j = await this.apiReq<{ data: { list: any[] }; metadata: { total: number } }>(
        "/file/sort",
        { pdir_fid: id, _size: "100", _fetch_total: "1", fetch_all_file: "1", _page: String(page) }
      );
      for (const f of j.data.list || []) out.push(this.toItem(f, path));
      if (page * 100 >= (j.metadata?.total || 0)) break;
      page++;
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    if (path === "/") return { name: "", path: "/", is_dir: true, size: 0, modified: 0 };
    const parent = path.split("/").slice(0, -1).join("/") || "/";
    const id = await this.resolveId(parent);
    let page = 1;
    let f: any;
    for (;;) {
      const j = await this.apiReq<{ data: { list: any[] }; metadata: { total: number } }>("/file/sort", { pdir_fid: id, _size: "100", _fetch_total: "1", fetch_all_file: "1", _page: String(page) });
      f = (j.data.list || []).find((x) => x.file_name === basename(path));
      if (f || page * 100 >= (j.metadata?.total || 0) || !(j.data.list || []).length) break;
      page++;
    }
    if (!f) throw new Error(`quark_uc: 不存在 ${path}`);
    return this.toItem(f, parent);
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const fid = await this.resolveId(path);
    const j = await this.apiReq<{ data: { download_url: string }[] }>("/file/download", { fids: fid }, "POST", { fids: [fid] });
    const url = j.data[0]?.download_url;
    if (!url) throw new Error("quark_uc: 无下载链接");
    return fetch(url, { headers: { Cookie: this.cfgStr("cookie"), Referer: REFERER, "User-Agent": UA, ...(range ? { Range: range } : {}) } });
  }

  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(_path)}`, method: "PUT", headers: { "x-driver": "quark_uc" } };
  }

  // Worker 代理：OSS 分片直传（流程与 OpenList quark_uc/util.go 一致）
  async putContent(path: string, body: ReadableStream, ct = "application/octet-stream", size = 0): Promise<void> {
    const parentId = await this.resolveId(path.split("/").slice(0, -1).join("/") || "/");
    const name = basename(path);
    const now = Date.now();
    const pre = await this.apiReq<any>("/file/upload/pre", {}, "POST", {
      ccp_hash_update: true,
      dir_name: "",
      file_name: name,
      format_type: ct,
      l_created_at: now,
      l_updated_at: now,
      pdir_fid: parentId,
      size,
    });
    const partSize = pre.metadata?.part_size || 4 * 1024 * 1024;
    const taskId = pre.data.task_id;
    const bucket = pre.data.bucket;
    const objKey = pre.data.obj_key;
    const authInfo = pre.data.auth_info;
    const uploadUrl = pre.data.upload_url;

    const buf = new Uint8Array(await new Response(body).arrayBuffer());
    const total = buf.length;
    if (size !== total) throw new Error(`quark_uc: 上传大小不一致：声明 ${size}，实际 ${total}`);
    if (total === 0) throw new Error("quark_uc: 暂不支持零字节上传");
    const nParts = Math.ceil(total / partSize);
    const md5s: string[] = [];
    for (let i = 0; i < nParts; i++) {
      const partNo = i + 1;
      const slice = buf.slice(i * partSize, Math.min((i + 1) * partSize, total));
      const timeStr = new Date().toUTCString();
      const authMeta = `PUT\n\n${ct}\n${timeStr}\nx-oss-date:${timeStr}\nx-oss-user-agent:${OSS_UA}\n/${bucket}/${objKey}?partNumber=${partNo}&uploadId=${pre.data.upload_id}`;
      const auth = await this.apiReq<any>("/file/upload/auth", {}, "POST", { auth_info: authInfo, auth_meta: authMeta, task_id: taskId });
      const authKey = auth.data.auth_key;
      const u = `https://${bucket}.${uploadUrl.slice(7)}/${objKey}?partNumber=${partNo}&uploadId=${pre.data.upload_id}`;
      const r = await fetch(u, {
        method: "PUT",
        headers: { Authorization: authKey, "Content-Type": ct, Referer: "https://pan.quark.cn/", "x-oss-date": timeStr, "x-oss-user-agent": OSS_UA },
        body: slice,
      });
      if (!r.ok) throw new Error(`quark_uc: 分片 ${partNo} 上传失败 ${r.status}`);
      md5s.push(r.headers.get("Etag") || "");
    }
    // commit
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload>\n`;
    md5s.forEach((m, i) => { xml += `<Part>\n<PartNumber>${i + 1}</PartNumber>\n<ETag>${m}</ETag>\n</Part>\n`; });
    xml += "</CompleteMultipartUpload>";
    const contentMd5 = b64(md5Hex(xml));
    const callbackB64 = b64(JSON.stringify(pre.data.callback || {}));
    const timeStr = new Date().toUTCString();
    const authMeta2 = `POST\n${contentMd5}\napplication/xml\n${timeStr}\nx-oss-callback:${callbackB64}\nx-oss-date:${timeStr}\nx-oss-user-agent:${OSS_UA}\n/${bucket}/${objKey}?uploadId=${pre.data.upload_id}`;
    const auth2 = await this.apiReq<any>("/file/upload/auth", {}, "POST", { auth_info: authInfo, auth_meta: authMeta2, task_id: taskId });
    const u2 = `https://${bucket}.${uploadUrl.slice(7)}/${objKey}?uploadId=${pre.data.upload_id}`;
    const r2 = await fetch(u2, {
      method: "POST",
      headers: {
        Authorization: auth2.data.auth_key,
        "Content-MD5": contentMd5,
        "Content-Type": "application/xml",
        Referer: "https://pan.quark.cn/",
        "x-oss-callback": callbackB64,
        "x-oss-date": timeStr,
        "x-oss-user-agent": OSS_UA,
      },
      body: xml,
    });
    if (!r2.ok) throw new Error(`quark_uc: 合并分片失败 ${r2.status}`);
    await this.apiReq("/file/upload/finish", {}, "POST", { obj_key: objKey, task_id: taskId });
  }

  async mkdir(path: string): Promise<void> {
    const parentId = await this.resolveId(path.split("/").slice(0, -1).join("/") || "/");
    await this.apiReq("/file", {}, "POST", { dir_init_lock: false, dir_path: "", file_name: basename(path), pdir_fid: parentId });
  }

  async remove(path: string): Promise<void> {
    const fid = await this.resolveId(path);
    await this.apiReq("/file/delete", {}, "POST", { action_type: 1, exclude_fids: [], filelist: [fid] });
  }

  async rename(from: string, to: string): Promise<void> {
    const fid = await this.resolveId(from);
    await this.apiReq("/file/rename", {}, "POST", { fid, file_name: basename(to) });
  }

  async move(from: string, to: string): Promise<void> {
    const fid = await this.resolveId(from);
    const dest = await this.resolveId(to.split("/").slice(0, -1).join("/") || "/");
    await this.apiReq("/file/move", {}, "POST", { action_type: 1, exclude_fids: [], filelist: [fid], to_pdir_fid: dest });
  }
}

function b64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

export type _Avoid = Env | DriverConfig;
