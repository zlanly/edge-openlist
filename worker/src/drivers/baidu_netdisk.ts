import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";

const API = "https://pan.baidu.com/rest/2.0";

// 百度网盘（OpenList 源码核对：drivers/baidu_netdisk/{driver.go,util.go,types.go}）
// 认证：access_token 以 query 参数附加（非 Header）。token 刷新走在线 API 或 openapi。
export class BaiduNetdiskDriver extends CloudBase {
  readonly id = "baidu_netdisk";
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
      let at = "";
      let nrt = rt;
      // 在线刷新 API（默认）或官方 openapi
      if (this.cfgStr("useOnlineApi") !== "false") {
        const renewUrl = new URL(this.cfgStr("apiUrlAddress") || "https://api.oplist.org/baiduyun/renewapi");
        renewUrl.searchParams.set("refresh_token", rt);
        const r = await fetch(renewUrl.toString(), {
          headers: { "Content-Type": "application/json" },
        });
        if (!r.ok) throw new Error(`在线刷新失败: HTTP ${r.status}`);
        const j = (await r.json()) as { access_token?: string; refresh_token?: string; text?: string };
        at = j.access_token || "";
        nrt = j.refresh_token || rt;
        if (!at) throw new Error(j.text || "在线刷新失败");
      } else {
        const r = await fetch("https://openapi.baidu.com/oauth/2.0/token?" + new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: rt,
          client_id: this.cfgStr("clientId") || "",
          client_secret: this.cfgStr("clientSecret") || "",
        }));
        const j = (await r.json()) as { access_token?: string; refresh_token?: string };
        at = j.access_token || "";
        nrt = j.refresh_token || rt;
        if (!at) throw new Error("刷新失败");
      }
      t = { access_token: at, refresh_token: nrt, expires_at: Date.now() + 30 * 24 * 3600 * 1000, extra: {} };
      await saveTokens(this.env.KV, this.mountId, t);
    }
    this.accessToken = t!.access_token;
    return this.accessToken;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  private async call<T>(path: string, params: Record<string, string>, resp: string): Promise<T> {
    const tk = await this.ensureToken();
    const url = `${API}${path}?${new URLSearchParams({ ...params, access_token: tk })}`;
    const r = await fetch(url, { headers: { "User-Agent": "pan.baidu.com" } });
    if (!r.ok) throw new Error(`GET ${r.status} ${url}`);
    const j = (await r.json()) as any;
    if (j.errno && j.errno !== 0) throw new Error(`baidu errno ${j.errno}`);
    return (resp ? j[resp] : j) as T;
  }

  async list(path: string): Promise<FileItem[]> {
    const dir = normalizePath(path);
    const list: { fs_id: number; path: string; server_filename: string; size: number; isdir: number; server_mtime: number; server_ctime: number; thumbs?: { url3?: string } }[] = [];
    for (let start = 0;;) {
      const page = await this.call<typeof list>(
        "/xpan/file",
        { method: "list", dir, web: "web", start: String(start), limit: "1000", order: this.cfgStr("orderBy") || "name", ...(this.cfgStr("orderDirection") === "desc" ? { desc: "1" } : {}) },
        "list",
      );
      list.push(...(page || []));
      if (!page || page.length < 1000) break;
      start += page.length;
    }
    return list.map((f) => ({
      name: f.server_filename,
      path: joinPath(dir, f.server_filename),
      is_dir: f.isdir === 1,
      size: f.size,
      modified: (f.server_mtime || f.server_ctime) * 1000,
      etag: String(f.fs_id),
    }));
  }

  async get(path: string): Promise<FileItem> {
    const items = await this.list(parentPath(path));
    const b = basename(path);
    const it = items.find((i) => i.name === b);
    if (!it) throw new Error("not found: " + path);
    return it;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const it = await this.get(path);
    // 官方直链：filemetas 取 dlink，再 HEAD 跟随 302 得到真实 URL
    const dl = await this.call<{ list: { dlink: string }[] }>(
      "/xpan/multimedia",
      { method: "filemetas", fsids: `[${it.etag}]`, dlink: "1" },
      "",
    );
    const dlink = dl.list?.[0]?.dlink;
    if (!dlink) throw new Error("no dlink");
    const tk = await this.ensureToken();
    const final = `${dlink}&access_token=${tk}`;
    return fetch(final, range ? { headers: { Range: range, "User-Agent": "pan.baidu.com" } } : { headers: { "User-Agent": "pan.baidu.com" } });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    // 百度上传需 content-md5/slice-md5（Web Crypto 无 MD5），走 Worker 代理流式分片
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "baidu_netdisk" } };
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, _size = 0): Promise<void> {
    // 忠实流程：precreate -> 分片上传到 uploadURL -> create。
    // 因 Web Crypto 不提供 MD5，无法计算 content-md5/slice-md5，故此处无法直接秒传/分片。
    // 见报告说明：需纯 JS MD5 实现才能完成分片上传。
    throw new Error("baidu_netdisk 分片上传需要 MD5（Web Crypto 未提供）；请使用预签名代理或补充 MD5 实现");
  }

  async mkdir(path: string): Promise<void> {
    const parent = parentPath(path);
    const name = basename(path);
    await this.call("", {}, ""); // no-op to satisfy token
    await this.form("/xpan/file", { method: "create" }, {
      path: parent === "/" ? "/" + name : parent + "/" + name,
      size: "0",
      isdir: "1",
      rtype: "3",
    });
  }

  async remove(path: string): Promise<void> {
    await this.form("/xpan/file", { method: "filemanager", opera: "delete" }, {
      async: "0",
      filelist: JSON.stringify([normalizePath(path)]),
      ondup: "fail",
    });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.form("/xpan/file", { method: "filemanager", opera: "rename" }, {
      async: "0",
      filelist: JSON.stringify([{ path: normalizePath(from), newname: basename(to) }]),
      ondup: "fail",
    });
  }

  async move(from: string, to: string): Promise<void> {
    await this.form("/xpan/file", { method: "filemanager", opera: "move" }, {
      async: "0",
      filelist: JSON.stringify([{ path: normalizePath(from), dest: parentPath(to), newname: basename(to) }]),
      ondup: "fail",
    });
  }

  private async form(path: string, q: Record<string, string>, data: Record<string, string>): Promise<void> {
    const tk = await this.ensureToken();
    const url = `${API}${path}?${new URLSearchParams({ ...q, access_token: tk })}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "pan.baidu.com" },
      body: new URLSearchParams(data).toString(),
    });
    if (!r.ok) throw new Error(`POST ${r.status} ${url}`);
    const j = (await r.json()) as any;
    if (j.errno && j.errno !== 0) throw new Error(`baidu errno ${j.errno}`);
  }
}
