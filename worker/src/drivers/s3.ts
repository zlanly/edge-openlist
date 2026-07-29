import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parseRange } from "./base";

// ---------- AWS SigV4 紧凑实现 ----------
async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key instanceof Uint8Array ? key : new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}
function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(data: ArrayBuffer | string | Uint8Array): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", buf));
}

interface S3Ctx {
  endpoint: string; // 不含桶，如 https://s3.example.com
  region: string;
  bucket: string;
  ak: string;
  sk: string;
  pathStyle: boolean;
}
function objectUrl(ctx: S3Ctx, key: string): string {
  const k = key.replace(/^\/+/, "");
  return ctx.pathStyle
    ? `${ctx.endpoint.replace(/\/$/, "")}/${ctx.bucket}/${k}`
    : `${ctx.endpoint.replace(/\/$/, "")}/${k}`;
}

async function signedHeaders(
  ctx: S3Ctx,
  method: string,
  url: string,
  extra: Record<string, string>,
  payloadHash: string
): Promise<Record<string, string>> {
  const u = new URL(url);
  const amzdate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 16);
  const datestamp = amzdate.slice(0, 8);
  const host = u.host;
  const headers: Record<string, string> = {
    host,
    "x-amz-date": amzdate,
    "x-amz-content-sha256": payloadHash,
    ...extra,
  };
  const signedNames = Object.keys(headers).sort();
  const canoHeaders = signedNames.map((n) => `${n.toLowerCase()}:${headers[n].trim()}\n`).join("");
  const canoReq = [
    method,
    u.pathname || "/",
    u.search.replace(/^\?/, ""),
    canoHeaders,
    signedNames.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${datestamp}/${ctx.region}/s3/aws4_request`;
  const str2sign = `AWS4-HMAC-SHA256\n${amzdate}\n${scope}\n${await sha256Hex(canoReq)}`;
  const kDate = await hmac(new TextEncoder().encode("AWS4" + ctx.sk), datestamp);
  const kRegion = await hmac(kDate, ctx.region);
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  const sig = hex(await hmac(kSigning, str2sign));
  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${ctx.ak}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${sig}`;
  return headers;
}

// 预签名 PUT（客户端直传）
async function presignPut(ctx: S3Ctx, key: string, expires = 3600): Promise<string> {
  const u = new URL(objectUrl(ctx, key));
  const amzdate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 16);
  const datestamp = amzdate.slice(0, 8);
  const scope = `${datestamp}/${ctx.region}/s3/aws4_request`;
  const q: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${ctx.ak}/${scope}`,
    "X-Amz-Date": amzdate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  };
  const qs = Object.keys(q)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(q[k])}`)
    .join("&");
  u.search = qs;
  const canoReq = ["PUT", u.pathname, qs, `host:${u.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const str2sign = `AWS4-HMAC-SHA256\n${amzdate}\n${scope}\n${await sha256Hex(canoReq)}`;
  const kDate = await hmac(new TextEncoder().encode("AWS4" + ctx.sk), datestamp);
  const kRegion = await hmac(kDate, ctx.region);
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  const sig = hex(await hmac(kSigning, str2sign));
  u.search += `&X-Amz-Signature=${sig}`;
  return u.toString();
}

// ---------- S3 驱动 ----------
export class S3Driver implements Driver {
  readonly id = "s3";
  private env!: Env;
  private ctx!: S3Ctx;
  private prefix = "";

  use(env: Env): void {
    this.env = env;
  }

  async init(cfg: DriverConfig): Promise<void> {
    this.ctx = {
      endpoint: cfg.endpoint as string,
      region: (cfg.region as string) || "auto",
      bucket: cfg.bucket as string,
      ak: cfg.accessKeyId as string,
      sk: cfg.secretAccessKey as string,
      pathStyle: cfg.pathStyle !== false,
    };
    const p = (cfg.prefix as string) || "";
    this.prefix = p ? p.replace(/^\/+|\/+$/g, "") : "";
  }

  private key(path: string): string {
    const rel = normalizePath(path).replace(/^\//, "");
    return this.prefix ? `${this.prefix}/${rel}` : rel;
  }

  async list(path: string): Promise<FileItem[]> {
    const dir = this.key(path);
    const prefix = dir ? dir + "/" : "";
    const url = `${this.ctx.endpoint.replace(/\/$/, "")}/${this.ctx.bucket}?list-type=2&prefix=${encodeURIComponent(
      prefix
    )}&delimiter=${encodeURIComponent("/")}`;
    const h = await signedHeaders(this.ctx, "GET", url, {}, await sha256Hex(""));
    const resp = await fetch(url, { headers: h });
    if (!resp.ok) throw new Error(`S3 list 失败: ${resp.status}`);
    const xml = await resp.text();
    const items: FileItem[] = [];
    const dirRe = /<CommonPrefixes><Prefix>([^<]+)<\/Prefix><\/CommonPrefixes>/g;
    let m: RegExpExecArray | null;
    while ((m = dirRe.exec(xml))) {
      const name = m[1].slice(prefix.length).replace(/\/$/, "");
      if (name) items.push({ name, path: joinPath(path, name), is_dir: true, size: 0, modified: 0 });
    }
    const fileRe = /<Contents><Key>([^<]+)<\/Key><Size>(\d+)<\/Size>(?:.*?<LastModified>([^<]+)<\/LastModified>)?/g;
    while ((m = fileRe.exec(xml))) {
      const full = decodeURIComponent(m[1]);
      const name = full.slice(prefix.length);
      if (!name) continue;
      items.push({
        name,
        path: joinPath(path, name),
        is_dir: false,
        size: Number(m[2]),
        modified: m[3] ? new Date(m[3]).getTime() : 0,
      });
    }
    return items;
  }

  async get(path: string): Promise<FileItem> {
    const key = this.key(path);
    const url = objectUrl(this.ctx, key);
    const h = await signedHeaders(this.ctx, "HEAD", url, {}, await sha256Hex(""));
    const resp = await fetch(url, { method: "HEAD", headers: h });
    if (!resp.ok) throw new Error("文件不存在");
    return {
      name: basename(path),
      path,
      is_dir: false,
      size: Number(resp.headers.get("Content-Length") || 0),
      modified: resp.headers.get("Last-Modified") ? new Date(resp.headers.get("Last-Modified")!).getTime() : 0,
    };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const key = this.key(path);
    const url = objectUrl(this.ctx, key);
    const extra: Record<string, string> = {};
    if (range) extra["range"] = range;
    const h = await signedHeaders(this.ctx, "GET", url, extra, await sha256Hex(""));
    if (range) h["range"] = range;
    const resp = await fetch(url, { headers: h, cf: { cacheTtl: 0 } } as any);
    if (!resp.ok && resp.status !== 206) throw new Error(`S3 get 失败: ${resp.status}`);
    return resp; // 直接透传流式响应
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    const url = await presignPut(this.ctx, this.key(path));
    return { uploadUrl: url, method: "PUT" };
  }

  async mkdir(path: string): Promise<void> {
    const key = this.key(path).replace(/\/?$/, "/");
    const url = objectUrl(this.ctx, key);
    const body = new Uint8Array(0);
    const h = await signedHeaders(this.ctx, "PUT", url, { "content-type": "application/x-directory" }, await sha256Hex(body));
    await fetch(url, { method: "PUT", headers: h, body });
  }

  async remove(path: string): Promise<void> {
    const key = this.key(path);
    const url = objectUrl(this.ctx, key);
    const h = await signedHeaders(this.ctx, "DELETE", url, {}, await sha256Hex(""));
    const r = await fetch(url, { method: "DELETE", headers: h });
    if (!r.ok && r.status !== 404) throw new Error(`S3 delete 失败: ${r.status}`);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.move(from, to);
  }

  async move(from: string, to: string): Promise<void> {
    const src = objectUrl(this.ctx, this.key(from));
    const dst = objectUrl(this.ctx, this.key(to));
    // Copy
    const copyH = await signedHeaders(this.ctx, "PUT", dst, { "x-amz-copy-source": src }, await sha256Hex(""));
    const copy = await fetch(dst, { method: "PUT", headers: copyH });
    if (!copy.ok) throw new Error(`S3 copy 失败: ${copy.status}`);
    // Delete source
    const delH = await signedHeaders(this.ctx, "DELETE", src, {}, await sha256Hex(""));
    await fetch(src, { method: "DELETE", headers: delH });
  }
}
