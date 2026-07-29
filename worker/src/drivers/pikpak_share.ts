// PikPak 分享（只读）。端点移植自 OpenList drivers/pikpak_share/*。
// captcha_sign 依赖 MD5（WebCrypto 无），内联纯 JS MD5。
import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";

const API_DRIVE = "https://api-drive.mypikpak.net/drive/v1";
const API_USER = "https://user.mypikpak.net/v1";
const WEB = { id: "YUMx5nI8ZU8Ap8pm", secret: "dbw2OtmVEeuUvIptb1Coyg", version: "2.0.0", pkg: "mypikpak.com" };
const WEB_ALGOS = [
  "C9qPpZLN8ucRTaTiUMWYS9cQvWOE", "+r6CQVxjzJV6LCV", "F", "pFJRC",
  "9WXYIDGrwTCz2OiVlgZa90qpECPD6olt", "/750aCr4lm/Sly/c", "RB+DT/gZCrbV", "",
  "CyLsf7hdkIRxRm215hl", "7xHvLi2tOYP0Y92b", "ZGTXXxu8E/MIWaEDB+Sm/", "1UI3",
  "E7fP5Pfijd+7K+t6Tg/NhuLq0eEUVChpJSkrKxpO", "ihtqpG6FMt65+Xk+tWUH2", "NhXXU9rg4XXdzo7u5o",
];
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36";

// ---- 纯 JS MD5（WebCrypto 无 MD5，用于 captcha_sign / deviceId）----
// 标准实现（RFC 1321），仅用于 PikPak 短字符串（deviceId / captcha_sign）。
function md5(s: string): string {
  const rotl = (n: number, c: number): number => (n << c) | (n >>> (32 - c));
  const msg = new TextEncoder().encode(s);
  const len = msg.length;
  const bitLen = len * 8;
  const total = (len + 1 + 8 + 63) & ~63;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, bitLen >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bitLen / 4294967296), true);
  const K = new Array<number>(64);
  for (let i = 0; i < 64; i++) K[i] = (Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  const S = [
    [7, 12, 17, 22],
    [5, 9, 14, 20],
    [4, 11, 16, 23],
    [6, 10, 15, 21],
  ];
  let [a0, b0, c0, d0] = [0x67452301, -0x10325477 | 0, -0x67452302 | 0, 0x10325476];
  const x = new Int32Array(16);
  for (let i = 0; i < total; i += 64) {
    for (let j = 0; j < 16; j++) x[j] = dv.getInt32(i + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let j = 0; j < 64; j++) {
      let f: number, g: number, s: number;
      if (j < 16) { f = (B & C) | (~B & D); g = j; s = S[0][j % 4]; }
      else if (j < 32) { f = (B & D) | (C & ~D); g = (5 * j + 1) % 16; s = S[1][j % 4]; }
      else if (j < 48) { f = B ^ C ^ D; g = (3 * j + 5) % 16; s = S[2][j % 4]; }
      else { f = C ^ (B | ~D); g = (7 * j) % 16; s = S[3][j % 4]; }
      f = (f + A + K[j] + x[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(f, s)) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, "0");
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

export class PikPakShareDriver extends CloudBase {
  readonly id = "pikpak_share";
  private shareId = "";
  private sharePwd = "";
  private passToken = "";
  private captchaToken = "";
  private deviceId = "";
  private useTrans = false;

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.shareId = this.cfgStr("share_id");
    this.sharePwd = this.cfgStr("share_pwd") || "";
    this.useTrans = this.cfgStr("use_transcoding_address") === "true";
    this.deviceId = this.cfgStr("device_id") || md5(this.shareId + this.sharePwd + String(Date.now()));
    this.captchaToken = this.cfgStr("captcha_token") || "";
    await this.refreshCaptchaToken("GET:/drive/v1/share:batch_file_info", "");
    if (this.sharePwd) await this.getSharePassToken();
  }

  private async getCaptchaSign(): Promise<[string, string]> {
    const ts = String(Date.now());
    let str = WEB.id + WEB.version + WEB.pkg + this.deviceId + ts;
    for (const algo of WEB_ALGOS) str = md5(str + algo);
    return [ts, "1." + str];
  }

  private async refreshCaptchaToken(action: string, userId: string): Promise<void> {
    const [ts, sign] = await this.getCaptchaSign();
    const body = {
      action,
      captcha_token: this.captchaToken,
      client_id: WEB.id,
      device_id: this.deviceId,
      meta: { client_version: WEB.version, package_name: WEB.pkg, user_id: userId, timestamp: ts, captcha_sign: sign },
    };
    const r = await fetch(`${API_USER}/shield/captcha/init?client_id=${WEB.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await r.json()) as any;
    if (j.error_code) throw new Error(`pikpak_share captcha: ${j.error || j.error_description}`);
    if (j.url) throw new Error(`pikpak_share 需要人机验证: ${j.url}`);
    this.captchaToken = j.captcha_token;
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {
      "User-Agent": UA,
      "X-Client-ID": WEB.id,
      "X-Device-ID": this.deviceId,
      "X-Captcha-Token": this.captchaToken,
    };
  }

  private async request<T>(url: string, query?: Record<string, string>, retry = true): Promise<T> {
    const u = new URL(url);
    if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    const r = await fetch(u.toString(), { method: "GET", headers: await this.hdrs() });
    const j = (await r.json().catch(() => ({}))) as any;
    if (j.error_code) {
      if (retry && j.error_code === 9) {
        await this.refreshCaptchaToken("GET:/drive/v1/share:batch_file_info", "");
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
    if (path === "/") return "root";
    const parent = parentPath(path);
    const items = await this.list(parent);
    const it = items.find((i) => i.path === path);
    if (!it) throw new Error("not found: " + path);
    return it.etag || "";
  }

  async list(path: string): Promise<FileItem[]> {
    const id = path === "/" ? "root" : await this.getIdByPath(path);
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
        out.push({
          name: f.name,
          path: joinPath(path, f.name),
          is_dir: f.kind === "drive#folder",
          size: Number(f.size || 0),
          modified: f.modified_time ? Date.parse(f.modified_time) : 0,
          etag: f.id,
        });
      }
      page = j.next_page_token || "";
      if (!page) break;
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    const items = await this.list(parentPath(path));
    const it = items.find((i) => i.path === path);
    if (!it) throw new Error("not found: " + path);
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
