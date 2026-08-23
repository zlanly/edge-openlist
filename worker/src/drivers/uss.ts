import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";

// 又拍云 USS 驱动
// 认证：REST 统一签名（HMAC-SHA1），密钥为 OperatorPassword 的 MD5。
// 源：OpenList drivers/uss + upyun/go-sdk/v3 (v3.0.4) rest.go / auth.go / utils.go
// 说明：upyun SDK 中 Password = md5(rawPassword)，签名用 MD5 后的密码。

const REST_HOST = "v0.api.upyun.com";
const DEFAULT_LIMIT = 256;

const enc = new TextEncoder();

function toB64(bytes: ArrayBuffer): string {
  const u = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

async function md5Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("MD5", enc.encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// upyun escapeUri：仅 A-Za-z0-9-._~ 不转义（按 UTF-8 字节逐字节处理，与 Go 一致）
function escapeUri(s: string): string {
  const bytes = enc.encode(s);
  let out = "";
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c)) out += c;
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

// 与 OpenList getKey 一致：去掉前缀 "/"，目录追加 "/"
function getKey(p: string, dir: boolean): string {
  let s = p.replace(/^\/+/, "");
  if (dir) s += "/";
  return s;
}

export class UssDriver extends CloudBase {
  readonly id = "uss";
  private bucket = "";
  private operator = "";
  private passwordMd5 = "";
  private endpoint = "";
  private antiTheftToken = "";
  private signExpire = 4;

  private cfgStr(k: string): string {
    const value = (this.cfg as Record<string, unknown>)[k];
    return value == null ? "" : String(value);
  }
  private cfgNum(k: string, d: number): number {
    const v = (this.cfg as Record<string, unknown>)[k];
    return typeof v === "number" ? v : d;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.bucket = this.cfgStr("bucket");
    this.operator = this.cfgStr("operator_name");
    this.passwordMd5 = await md5Hex(this.cfgStr("operator_password"));
    this.endpoint = this.cfgStr("endpoint") || REST_HOST;
    if (!/:\/\//.test(this.endpoint)) this.endpoint = "https://" + this.endpoint;
    this.antiTheftToken = this.cfgStr("anti_theft_chain_token");
    this.signExpire = this.cfgNum("sign_url_expire", 4);
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  // 统一 REST 签名（MakeUnifiedAuth，非 deprecated 路径）
  // sign = base64(HMAC-SHA1(passwordMd5, METHOD&Uri&Date&ContentMD5))，空字段剔除
  private async authHeader(method: string, uri: string, date: string, contentMd5 = ""): Promise<string> {
    const parts = [method, uri, date, contentMd5].filter((v) => v !== "");
    const signStr = parts.join("&");
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(this.passwordMd5),
      { name: "HMAC", hash: { name: "SHA-1" } },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signStr));
    return "UpYun " + this.operator + ":" + toB64(sig);
  }

  // 构造并发送一次 REST 请求（body 可流式）
  private async rest(
    method: string,
    key: string,
    headers: Record<string, string> = {},
    body?: BodyInit | null,
    allowNotFound = false,
  ): Promise<Response> {
    const uri = ["", this.bucket, escapeUri(key)].join("/").replace(/\/{2,}/g, "/");
    const finalUri = key.endsWith("/") ? uri + "/" : uri;
    const date = new Date().toUTCString(); // RFC1123 (GMT)
    const auth = await this.authHeader(method, finalUri, date, headers["Content-MD5"] || "");
    const endpoint = this.endpoint.replace(/\/+$/, "");
    const endpointHost = new URL(endpoint).host;
    const r = await fetch(`${endpoint}${finalUri}`, {
      method,
      headers: {
        Host: endpointHost,
        Date: date,
        Authorization: auth,
        ...headers,
      },
      body,
    });
    if (!r.ok && r.status !== 206 && !(allowNotFound && r.status === 404)) {
      throw new Error(`USS ${method} ${r.status} ${finalUri}: ${await r.text().catch(() => "")}`);
    }
    return r;
  }

  async list(path: string): Promise<FileItem[]> {
    const key = getKey(path, true);
    const items: FileItem[] = [];
    let iter = "";
    for (;;) {
      const h: Record<string, string> = {
        "X-List-Limit": String(DEFAULT_LIMIT),
        "X-UpYun-Folder": "true",
        Accept: "application/json",
      };
      if (iter) h["X-List-Iter"] = iter;
      const r = await this.rest("GET", key, h);
      const j = (await r.json()) as { files?: any[]; iter?: string };
      for (const f of j.files || []) {
        const isDir = f.type === "folder";
        items.push({
          name: f.name,
          path: joinPath(path, f.name),
          is_dir: isDir,
          size: Number(f.length || 0),
          modified: Number(f.last_modified || 0) * 1000,
        });
      }
      const next = j.iter || "";
      if (!next || next === iter || next === "g2gCZAAEbmV4dGQAA2VvZg") break; // 终止符（upyun SDK 约定）
      iter = next;
    }
    return items;
  }

  // HEAD 探测文件/目录元信息；返回 null 表示不存在
  private async head(path: string): Promise<{ is_dir: boolean; size: number; modified: number } | null> {
    const fileKey = getKey(path, false);
    let r = await this.rest("HEAD", fileKey, {}, undefined, true);
    if (!r.ok) {
      const dirKey = getKey(path, true);
      r = await this.rest("HEAD", dirKey, {}, undefined, true);
      if (!r.ok) return null;
      return {
        is_dir: true,
        size: Number(r.headers.get("x-upyun-file-size") || 0),
        modified: Number(r.headers.get("x-upyun-file-date") || 0) * 1000,
      };
    }
    return {
      is_dir: r.headers.get("x-upyun-file-type") === "folder",
      size: Number(r.headers.get("x-upyun-file-size") || 0),
      modified: Number(r.headers.get("x-upyun-file-date") || 0) * 1000,
    };
  }

  async get(path: string): Promise<FileItem> {
    const info = await this.head(path);
    if (!info) throw new Error(`USS: 对象不存在 ${path}`);
    return {
      name: basename(path),
      path: normalizePath(path),
      is_dir: info.is_dir,
      size: info.size,
      modified: info.modified,
    };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const key = getKey(path, false);
    const h: Record<string, string> = { "X-UpYun-Folder": "false" };
    if (range) h["Range"] = range;
    return this.rest("GET", key, h); // 流式转发
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    // 又拍云无预签名直传（每次请求需 HMAC 签名），走 Worker 代理流式 PUT
    return {
      uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`,
      method: "PUT",
      headers: { "x-driver": "uss" },
    };
  }

  // Worker 代理流式上传：PUT 文件内容到 USS（不缓冲整文件）
  async putContent(path: string, body: ReadableStream, ct = "application/octet-stream"): Promise<void> {
    const key = getKey(path, false);
    await this.rest("PUT", key, { "Content-Type": ct }, body as unknown as BodyInit);
  }

  async mkdir(path: string): Promise<void> {
    const key = getKey(path, true);
    await this.rest("POST", key, { folder: "true", "x-upyun-folder": "true" });
  }

  async remove(path: string): Promise<void> {
    if (normalizePath(path) === "/") throw new Error("不能删除根目录");
    const info = await this.head(path);
    if (!info) return;
    const key = getKey(path, info.is_dir);
    const h: Record<string, string> = {};
    if (info.is_dir) h["x-upyun-folder"] = "true";
    await this.rest("DELETE", key, h);
  }

  private async moveOrRename(from: string, to: string, isRename: boolean): Promise<void> {
    if (normalizePath(from) === "/" || normalizePath(to) === "/") throw new Error("不能移动或重命名根目录");
    const fromInfo = await this.head(from);
    if (!fromInfo) throw new Error(`USS: 源不存在 ${from}`);
    const srcKey = getKey(from, fromInfo.is_dir);
    const destName = isRename ? basename(to) : basename(from);
    const destParent = isRename ? parentPath(from) : parentPath(to);
    const destKey = getKey(joinPath(destParent, destName), fromInfo.is_dir);
    // X-Upyun-Move-Source = "/{bucket}/{srcKey}"
    const srcHeader = ["", this.bucket, escapeUri(srcKey)].join("/").replace(/\/{2,}/g, "/");
    await this.rest("PUT", destKey, { "X-Upyun-Move-Source": srcHeader });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.moveOrRename(from, to, true);
  }

  async move(from: string, to: string): Promise<void> {
    await this.moveOrRename(from, to, false);
  }
}

export type _Avoid = Env | DriverConfig;
