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
function encodeRFC3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeKey(key: string): string {
  return key.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

function objectUrl(ctx: S3Ctx, key: string): string {
  const k = encodeKey(key);
  const endpoint = ctx.endpoint.replace(/\/$/, "");
  if (ctx.pathStyle) return `${endpoint}/${encodeURIComponent(ctx.bucket)}/${k}`;
  const u = new URL(endpoint);
  if (u.hostname === "localhost" || /^[0-9.]+$/.test(u.hostname) || u.port) {
    return `${endpoint}/${encodeURIComponent(ctx.bucket)}/${k}`;
  }
  u.hostname = `${ctx.bucket}.${u.hostname}`;
  u.pathname = `${u.pathname.replace(/\/$/, "")}/${k}`;
  return u.toString();
}

function copySource(ctx: S3Ctx, key: string): string {
  return `/${encodeURIComponent(ctx.bucket)}/${encodeKey(key)}`;
}

function xmlUnescape(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
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
  const canonicalQuery = [...u.searchParams.entries()]
    .map(([name, value]) => [encodeRFC3986(name), encodeRFC3986(value)] as const)
    .sort(([an, av], [bn, bv]) => an === bn ? av.localeCompare(bv) : an.localeCompare(bn))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canoReq = [
    method,
    u.pathname || "/",
    canonicalQuery,
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
    const items: FileItem[] = [];
    const seen = new Set<string>();
    let token = "";
    do {
      const base = objectUrl(this.ctx, "");
      const params = new URLSearchParams({ "list-type": "2", prefix, delimiter: "/" });
      if (token) params.set("continuation-token", token);
      const url = `${base}?${params.toString()}`;
      const h = await signedHeaders(this.ctx, "GET", url, {}, await sha256Hex(""));
      const resp = await fetch(url, { headers: h });
      if (!resp.ok) throw new Error(`S3 list 失败: ${resp.status}`);
      const xml = await resp.text();
      const dirRe = /<CommonPrefixes>[\s\S]*?<Prefix>([^<]+)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g;
      let m: RegExpExecArray | null;
      while ((m = dirRe.exec(xml))) {
        const name = xmlUnescape(m[1]).slice(prefix.length).replace(/\/$/, "");
        if (name && !seen.has(`d:${name}`)) { seen.add(`d:${name}`); items.push({ name, path: joinPath(path, name), is_dir: true, size: 0, modified: 0 }); }
      }
      const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
      while ((m = contentsRe.exec(xml))) {
        const block = m[1];
        const keyMatch = block.match(/<Key>([^<]*)<\/Key>/);
        const sizeMatch = block.match(/<Size>(\d+)<\/Size>/);
        const dateMatch = block.match(/<LastModified>([^<]+)<\/LastModified>/);
        if (!keyMatch || !sizeMatch) continue;
        const full = xmlUnescape(keyMatch[1]);
        const name = full.slice(prefix.length);
        if (!name || seen.has(`f:${name}`)) continue;
        seen.add(`f:${name}`);
        items.push({ name, path: joinPath(path, name), is_dir: false, size: Number(sizeMatch[1]), modified: dateMatch ? new Date(dateMatch[1]).getTime() : 0 });
      }
      const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
      token = next ? xmlUnescape(next[1]) : "";
    } while (token);
    return items;
  }

  private async listAllKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token = "";
    do {
      const base = objectUrl(this.ctx, "");
      const params = new URLSearchParams({ "list-type": "2", prefix });
      if (token) params.set("continuation-token", token);
      const url = `${base}?${params.toString()}`;
      const headers = await signedHeaders(this.ctx, "GET", url, {}, await sha256Hex(""));
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(`S3 列举对象失败: ${response.status}`);
      const xml = await response.text();
      const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
      let match: RegExpExecArray | null;
      while ((match = contentsRe.exec(xml))) {
        const key = match[1].match(/<Key>([^<]*)<\/Key>/)?.[1];
        if (key != null) keys.push(xmlUnescape(key));
      }
      const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
      token = next ? xmlUnescape(next[1]) : "";
    } while (token);
    return keys;
  }

  private async deleteKey(key: string): Promise<void> {
    const url = objectUrl(this.ctx, key);
    const headers = await signedHeaders(this.ctx, "DELETE", url, {}, await sha256Hex(""));
    const response = await fetch(url, { method: "DELETE", headers });
    if (!response.ok && response.status !== 404) throw new Error(`S3 删除失败: ${response.status}`);
  }

  private async copyKey(sourceKey: string, targetKey: string): Promise<void> {
    const targetUrl = objectUrl(this.ctx, targetKey);
    const headers = await signedHeaders(
      this.ctx,
      "PUT",
      targetUrl,
      { "x-amz-copy-source": copySource(this.ctx, sourceKey) },
      await sha256Hex(""),
    );
    const response = await fetch(targetUrl, { method: "PUT", headers });
    const xml = await response.text();
    if (!response.ok || /<Error(?:>| )/.test(xml) || !/<CopyObjectResult>/.test(xml)) {
      throw new Error(`S3 复制失败: ${response.status}${xml ? ` ${xml}` : ""}`);
    }
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
    const response = await fetch(url, { method: "PUT", headers: h, body });
    if (!response.ok) throw new Error(`S3 创建目录失败: ${response.status}`);
  }

  async remove(path: string): Promise<void> {
    const key = this.key(path);
    const url = objectUrl(this.ctx, key);
    const headers = await signedHeaders(this.ctx, "HEAD", url, {}, await sha256Hex(""));
    const head = await fetch(url, { method: "HEAD", headers });
    if (head.ok) {
      await this.deleteKey(key);
      return;
    }
    if (head.status !== 404) throw new Error(`S3 查询对象失败: ${head.status}`);
    const prefix = key.endsWith("/") ? key : key + "/";
    const keys = await this.listAllKeys(prefix);
    if (!keys.length) throw new Error("文件或目录不存在");
    for (const objectKey of keys) await this.deleteKey(objectKey);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.move(from, to);
  }

  async move(from: string, to: string): Promise<void> {
    const sourceKey = this.key(from);
    const targetKey = this.key(to);
    if (sourceKey === targetKey || targetKey.startsWith(sourceKey.endsWith("/") ? sourceKey : sourceKey + "/")) {
      throw new Error("不能移动到自身或自身子目录");
    }
    const sourcePrefix = sourceKey.endsWith("/") ? sourceKey : sourceKey + "/";
    const keys = await this.listAllKeys(sourcePrefix);
    const sourceUrl = objectUrl(this.ctx, sourceKey);
    const headers = await signedHeaders(this.ctx, "HEAD", sourceUrl, {}, await sha256Hex(""));
    const head = await fetch(sourceUrl, { method: "HEAD", headers });
    if (head.ok && !keys.length) {
      await this.copyKey(sourceKey, targetKey);
      await this.deleteKey(sourceKey);
      return;
    }
    if (!head.ok && head.status !== 404) throw new Error(`S3 查询对象失败: ${head.status}`);
    const targetPrefix = targetKey.endsWith("/") ? targetKey : targetKey + "/";
    if (!keys.length) throw new Error("文件或目录不存在");
    for (const objectKey of keys) {
      await this.copyKey(objectKey, targetPrefix + objectKey.slice(sourcePrefix.length));
    }
    for (const objectKey of keys) await this.deleteKey(objectKey);
  }

}
