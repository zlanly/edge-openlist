// PikPak 分享（只读）。端点移植自 OpenList drivers/pikpak_share/*。
// captcha_sign 依赖 MD5（WebCrypto 无），内联纯 JS MD5。
import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import {
  getPikPakClient,
  isPikPakCaptchaCode,
  md5,
  parsePikPakResponse,
  pikpakClientHeaders,
  pikpakRootId,
} from "./pikpak-common";

const API_DRIVE = "https://api-drive.mypikpak.net/drive/v1";
const API_USER = "https://user.mypikpak.net/v1";
export class PikPakShareDriver extends CloudBase {
  readonly id = "pikpak_share";
  private shareId = "";
  private sharePwd = "";
  private passToken = "";
  private captchaToken = "";
  private deviceId = "";
  private useTrans = false;
  private rootId = "";
  private readonly idCache = new Map<string, string>();
  private readonly itemCache = new Map<string, FileItem>();

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  private get platform(): string {
    return this.cfgStr("platform") || "web";
  }
  private get client() {
    return getPikPakClient(this.platform, this.deviceId);
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.shareId = this.cfgStr("share_id").trim();
    if (!this.shareId) throw new Error("pikpak_share 需要 share_id");
    this.sharePwd = this.cfgStr("share_pwd") || "";
    this.rootId = pikpakRootId(this.cfg as Record<string, unknown>);
    this.idCache.clear();
    this.itemCache.clear();
    this.idCache.set("/", this.rootId);
    this.useTrans = this.cfgStr("use_transcoding_address") === "true";
    this.deviceId = this.cfgStr("device_id") || md5(this.shareId + this.sharePwd + String(Date.now()));
    this.captchaToken = this.cfgStr("captcha_token") || "";
    await this.refreshCaptchaToken("GET:/drive/v1/share:batch_file_info", "");
    if (this.sharePwd) await this.getSharePassToken();
  }

  private async getCaptchaSign(): Promise<[string, string]> {
    const ts = String(Date.now());
    let str = this.client.id + this.client.version + this.client.pkg + this.deviceId + ts;
    for (const algo of this.client.algorithms) str = md5(str + algo);
    return [ts, "1." + str];
  }

  private async refreshCaptchaToken(action: string, userId: string): Promise<void> {
    const [ts, sign] = await this.getCaptchaSign();
    const body = {
      action,
      captcha_token: this.captchaToken,
      client_id: this.client.id,
      device_id: this.deviceId,
      meta: { client_version: this.client.version, package_name: this.client.pkg, user_id: userId, timestamp: ts, captcha_sign: sign },
      redirect_uri: "xlaccsdk01://xbase.cloud/callback?state=harbor",
    };
    const r = await fetch(`${API_USER}/shield/captcha/init`, {
      method: "POST",
      headers: pikpakClientHeaders(this.client, this.deviceId, this.captchaToken),
      body: JSON.stringify(body),
    });
    const j = await parsePikPakResponse<any>(r, "分享验证码", true);
    if (j.error_code) throw new Error(`pikpak_share captcha: ${j.error || j.error_description}`);
    if (j.url) throw new Error(`pikpak_share 需要人机验证: ${j.url}`);
    this.captchaToken = j.captcha_token;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {
      "User-Agent": this.client.userAgent,
      "X-Client-ID": this.client.id,
      "X-Device-ID": this.deviceId,
      "X-Captcha-Token": this.captchaToken,
    };
  }

  private requestAction(url: string): string {
    return "GET:" + new URL(url).pathname;
  }

  private async request<T>(url: string, query?: Record<string, string>, retry = true): Promise<T> {
    const u = new URL(url);
    if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    const r = await fetch(u.toString(), { method: "GET", headers: await this.hdrs() });
    const j = await parsePikPakResponse<any>(r, `GET ${u.pathname}`, true);
    if (j.error_code) {
      if (retry && isPikPakCaptchaCode(j.error_code)) {
        await this.refreshCaptchaToken(this.requestAction(url), "");
        return this.request<T>(url, query, false);
      }
      if (j.error_code === 10) throw new Error(`pikpak_share: ${j.error_description}`);
      throw new Error(`pikpak_share: ${j.error || j.error_description}`);
    }
    return j as T;
  }

  private async getSharePassToken(): Promise<void> {
    const j = await this.request<any>(`${API_DRIVE}/share`, {
      share_id: this.shareId,
      pass_code: this.sharePwd,
      thumbnail_size: "SIZE_LARGE",
      limit: "100",
    });
    this.passToken = j.pass_code_token;
  }

  private async getIdByPath(path: string): Promise<string> {
    const normalized = normalizePath(path);
    // 空字符串是 PikPak 分享根目录的合法 ID，不能用 truthy 判断缓存命中，
    // 否则根目录会在 getIdByPath 与 list 之间无限递归。
    if (this.idCache.has(normalized)) return this.idCache.get(normalized) || "";
    const parent = parentPath(normalized);
    const items = await this.list(parent);
    const it = items.find((i) => normalizePath(i.path) === normalized);
    if (!it?.etag) throw new Error("not found: " + normalized);
    this.idCache.set(normalized, it.etag);
    return it.etag;
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.getIdByPath(path);
    const out: FileItem[] = [];
    let page = "first";
    for (;;) {
      if (page === "first") page = "";
      const j = await this.request<any>(`${API_DRIVE}/share/detail`, {
        parent_id: id,
        share_id: this.shareId,
        thumbnail_size: "SIZE_LARGE",
        with_audit: "true",
        limit: "100",
        filters: `{"phase":{"eq":"PHASE_TYPE_COMPLETE"},"trashed":{"eq":false}}`,
        page_token: page,
        pass_code_token: this.passToken,
      });
      if (j.share_status && j.share_status !== "OK") {
        if (j.share_status === "PASS_CODE_EMPTY" || j.share_status === "PASS_CODE_ERROR") {
          await this.getSharePassToken();
          page = "first";
          continue;
        }
        throw new Error(`pikpak_share: ${j.share_status_text}`);
      }
      for (const f of j.files || []) {
        const itemPath = joinPath(path, f.name);
        const item: FileItem = {
          name: f.name,
          path: itemPath,
          is_dir: f.kind === "drive#folder",
          size: Number(f.size || 0),
          modified: f.modified_time ? Date.parse(f.modified_time) : 0,
          etag: f.id,
        };
        if (f.id) this.idCache.set(normalizePath(itemPath), f.id);
        this.itemCache.set(normalizePath(itemPath), item);
        out.push(item);
      }
      page = j.next_page_token || "";
      if (!page) break;
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    const normalized = normalizePath(path);
    const cached = this.itemCache.get(normalized);
    if (cached) return cached;
    const items = await this.list(parentPath(normalized));
    const it = items.find((i) => normalizePath(i.path) === normalized);
    if (!it) throw new Error("not found: " + normalized);
    return it;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const id = await this.getIdByPath(path);
    const resp = await this.request<any>(`${API_DRIVE}/share/file_info`, {
      share_id: this.shareId,
      file_id: id,
      pass_code_token: this.passToken,
    });
    let url = resp.file_info?.web_content_link;
    if (!url && resp.file_info?.medias?.length) {
      url = this.useTrans && resp.file_info.medias[1]?.link?.url
        ? resp.file_info.medias[1].link.url
        : resp.file_info.medias[0].link.url;
    }
    if (!url) throw new Error("pikpak_share 无法获取下载链接");
    const h: Record<string, string> = {};
    if (range) h["Range"] = range;
    return fetch(url, { headers: h });
  }

  // 只读分享：不支持写操作（meta.go NoUpload:true）
  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    throw new Error("pikpak_share 为只读分享，不支持上传");
  }
  async mkdir(_path: string): Promise<void> { throw new Error("pikpak_share 为只读分享"); }
  async remove(_path: string): Promise<void> { throw new Error("pikpak_share 为只读分享"); }
  async rename(_from: string, _to: string): Promise<void> { throw new Error("pikpak_share 为只读分享"); }
  async move(_from: string, _to: string): Promise<void> { throw new Error("pikpak_share 为只读分享"); }
}

export type _Avoid = Env | DriverConfig;
