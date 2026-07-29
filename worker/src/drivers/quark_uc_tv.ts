import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, isExpired, type TokenSet } from "../util/tokenstore";
import { md5Hex } from "../util/md5";

const API = "https://open-api-drive.quark.cn";
const CODEAPI = "http://api.extscreen.com/quarkdrive";
const CLIENT_ID = "d3194e61504e493eb6222857bccfed94";
const SIGN_KEY = "kw2dvtd7p4t3pjl2d9ed7yc8yej8kw2d";
const APP_VER = "1.8.2.2";
const CHANNEL = "GENERAL";
const UA = "Mozilla/5.0 (Linux; U; Android 13; zh-cn; M2004J7AC Build/UKQ1.231108.001) AppleWebKit/533.1 (KHTML, like Gecko) Mobile Safari/533.1";

// 夸克 UC TV 端（signature + refresh_token，OpenList 标记 NoUpload，无上传/增删改）
export class QuarkUCTVDriver extends CloudBase {
  readonly id: string = "quark_uc_tv";
  private accessToken = "";
  private refreshToken = "";
  private deviceId = "";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  // 签名驱动走自定义 signed()/qreq()，hdrs() 仅用于满足 CloudBase 抽象契约
  protected async hdrs(): Promise<Record<string, string>> {
    return { Accept: "application/json, text/plain, */*", "User-Agent": UA };
  }

  private async ensureToken(): Promise<void> {
    let t = await loadTokens(this.env.KV, this.mountId);
    if (isExpired(t)) {
      const rt = this.cfgStr("refresh_token") || t?.refresh_token || "";
      if (!rt) throw new Error("quark_uc_tv: 缺少 refresh_token（TV 端需先扫码授权）");
      await this.refreshTokenByTV(rt, true);
      return;
    }
    this.accessToken = t!.access_token;
    this.refreshToken = t!.refresh_token || this.cfgStr("refresh_token");
    this.deviceId = (t!.extra?.device_id as string) || this.cfgStr("device_id") || md5Hex(String(Date.now()));
  }

  private async refreshTokenByTV(code: string, isRefresh: boolean): Promise<void> {
    const deviceId = this.deviceId || this.cfgStr("device_id") || md5Hex(String(Date.now()));
    const ts = String(Date.now());
    const reqID = md5Hex(deviceId + ts);
    const body: Record<string, string> = {
      req_id: reqID, app_ver: APP_VER, device_id: deviceId,
      device_brand: "Xiaomi", platform: "tv", device_name: "M2004J7AC", device_model: "M2004J7AC",
      build_device: "M2004J7AC", build_product: "M2004J7AC", device_gpu: "Adreno (TM) 550",
      activity_rect: "{}", channel: CHANNEL,
    };
    body[isRefresh ? "refresh_token" : "code"] = code;
    const r = await fetch(`${CODEAPI}/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`quark_uc_tv: 令牌刷新失败 ${r.status}`);
    const j = (await r.json()) as any;
    if (j.code !== 200 || !j.data?.refresh_token) throw new Error(`quark_uc_tv: ${j.message || "刷新失败"}`);
    this.accessToken = j.data.access_token;
    this.refreshToken = j.data.refresh_token;
    this.deviceId = deviceId;
    await saveTokens(this.env.KV, this.mountId, {
      access_token: this.accessToken, refresh_token: this.refreshToken,
      expires_at: Date.now() + (Number(j.data.expires_in) || 3600) * 1000,
      extra: { device_id: deviceId },
    });
  }

  private async signed(method: string, pathname: string): Promise<{ h: Record<string, string>; q: Record<string, string> }> {
    await this.ensureToken();
    const ts = String(Date.now());
    const token = await sha256Hex(`${method}&${pathname}&${ts}&${SIGN_KEY}`);
    const reqID = md5Hex(this.deviceId + ts);
    const h: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "User-Agent": UA,
      "x-pan-tm": ts,
      "x-pan-token": token,
      "x-pan-client-id": CLIENT_ID,
    };
    const q: Record<string, string> = {
      req_id: reqID, access_token: this.accessToken, app_ver: APP_VER, device_id: this.deviceId,
      device_brand: "Xiaomi", platform: "tv", device_name: "M2004J7AC", device_model: "M2004J7AC",
      build_device: "M2004J7AC", build_product: "M2004J7AC", device_gpu: "Adreno (TM) 550",
      activity_rect: "{}", channel: CHANNEL,
    };
    return { h, q };
  }

  private async qreq<T>(pathname: string, params: Record<string, string>, method = "GET"): Promise<T> {
    const { h, q } = await this.signed(method, pathname);
    const full = { ...q, ...params };
    const r = await fetch(`${API}${pathname}?${new URLSearchParams(full).toString()}`, { method, headers: h });
    const j = (await r.json()) as any;
    if (j.status >= 400 || (j.errno !== undefined && j.errno !== 0)) throw new Error(`quark_uc_tv: ${j.error_info || j.message}`);
    return j as T;
  }

  private async resolveId(path: string): Promise<string> {
    if (path === "/") return "0";
    let pdir = "0";
    for (const seg of path.split("/").filter(Boolean)) {
      const j = await this.qreq<{ data: { files: any[]; total_count: number } }>("/file", {
        method: "list", parent_fid: pdir, order_by: "3", desc: "1", category: "", source: "", ex_source: "", list_all: "0", page_size: "100", page_index: "0",
      });
      const item = (j.data.files || []).find((f) => f.filename === seg);
      if (!item) throw new Error(`quark_uc_tv: 路径不存在 ${path}`);
      pdir = item.fid;
    }
    return pdir;
  }

  private toItem(f: any, base: string): FileItem {
    return {
      name: f.filename,
      path: joinPath(base, f.filename),
      is_dir: f.isdir === 1,
      size: Number(f.size || 0),
      modified: f.updated_at ? Number(f.updated_at) : 0,
      etag: f.fid,
    };
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.resolveId(path);
    const out: FileItem[] = [];
    let page = 0;
    for (;;) {
      const j = await this.qreq<{ data: { files: any[]; total_count: number } }>("/file", {
        method: "list", parent_fid: id, order_by: "3", desc: "1", category: "", source: "", ex_source: "", list_all: "0", page_size: "100", page_index: String(page),
      });
      for (const f of j.data.files || []) out.push(this.toItem(f, path));
      if (page * 100 >= (j.data.total_count || 0)) break;
      page++;
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    if (path === "/") return { name: "", path: "/", is_dir: true, size: 0, modified: 0 };
    const parent = path.split("/").slice(0, -1).join("/") || "/";
    const id = await this.resolveId(parent);
    const j = await this.qreq<{ data: { files: any[] } }>("/file", { method: "list", parent_fid: id, page_size: "100", page_index: "0" });
    const name = path.split("/").pop();
    const f = (j.data.files || []).find((x) => x.filename === name);
    if (!f) throw new Error(`quark_uc_tv: 不存在 ${path}`);
    return this.toItem(f, parent);
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const fid = await this.resolveId(path);
    const j = await this.qreq<{ data: { download_url: string } }>("/file", { method: "download", group_by: "source", fid, resolution: "low,normal,high,super,2k,4k", support: "dolby_vision" });
    const url = j.data.download_url;
    if (!url) throw new Error("quark_uc_tv: 无下载链接");
    return fetch(url, range ? { headers: { Range: range } } : {});
  }

  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    throw new Error("quark_uc_tv: OpenList 标记 NoUpload，不支持上传");
  }

  async mkdir(_path: string): Promise<void> {
    throw new Error("quark_uc_tv: 不支持创建目录（OpenList NotImplement）");
  }
  async remove(_path: string): Promise<void> {
    throw new Error("quark_uc_tv: 不支持删除（OpenList NotImplement）");
  }
  async rename(_from: string, _to: string): Promise<void> {
    throw new Error("quark_uc_tv: 不支持重命名（OpenList NotImplement）");
  }
  async move(_from: string, _to: string): Promise<void> {
    throw new Error("quark_uc_tv: 不支持移动（OpenList NotImplement）");
  }
}

// UCTV 变体（端点 open-api-drive.uc.cn，clientID/signKey 不同）
export class UCTVDriver extends QuarkUCTVDriver {
  readonly id = "uc_tv";
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type _Avoid = Env | DriverConfig;
