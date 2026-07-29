import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";

// MediaTrack（mediatrack.cn）。端点严格对齐 drivers/mediatrack/{driver,util,meta,types}.go
// 鉴权 Bearer。列表/写操作走 jayce/kayn.api.mediatrack.cn；
// 上传：获取腾讯云 COS 临时凭证后，用 AWS SigV4（UNSIGNED-PAYLOAD，流式）PUT 到 COS，再登记资产。
interface MTAsset { id: string; title: string; size: string; type: number; updated_at: string; file?: { cover: string }; }

export class MediaTrackDriver extends CloudBase {
  readonly id = "mediatrack";
  private accessToken = "";
  private projectId = "";
  private rootId = "";
  private orderBy = "title";
  private orderDesc = false;

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }
  private cfgBool(k: string): boolean {
    return this.cfg[k] === true || this.cfg[k] === "true";
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.accessToken = this.cfgStr("access_token") || "";
    this.projectId = this.cfgStr("project_id") || "";
    this.rootId = this.cfgStr("root") || this.projectId;
    this.orderBy = this.cfgStr("order_by") || "title";
    this.orderDesc = this.cfgBool("order_desc");
    if (!this.accessToken) throw new Error("mediatrack: 缺少 access_token");
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Authorization: "Bearer " + this.accessToken };
  }

  private async mtGet<T>(url: string): Promise<T> {
    const r = await fetch(url, { headers: { Authorization: "Bearer " + this.accessToken } });
    if (!r.ok) throw new Error(`mediatrack GET ${r.status} ${url}`);
    const j = (await r.json()) as any;
    if (j.status && j.status !== "SUCCESS") throw new Error(`mediatrack: ${j.message}`);
    return j as T;
  }
  private async mtReq(method: string, url: string, body?: unknown): Promise<any> {
    const r = await fetch(url, {
      method,
      headers: { Authorization: "Bearer " + this.accessToken, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`mediatrack ${method} ${r.status} ${url}`);
    const j = (await r.json().catch(() => null)) as any;
    if (j && j.status && j.status !== "SUCCESS") throw new Error(`mediatrack: ${j.message}`);
    return j;
  }

  private async getChildren(parentId: string): Promise<MTAsset[]> {
    const out: MTAsset[] = [];
    const sort = (this.orderDesc ? "-" : "") + this.orderBy;
    for (let page = 1; ; page++) {
      const j = await this.mtGet<{ data: { assets: MTAsset[] } }>(
        `https://jayce.api.mediatrack.cn/v4/assets/${parentId}/children?page=${page}&size=50&sort=${encodeURIComponent(sort)}`
      );
      const arr = j.data?.assets || [];
      if (!arr.length) break;
      out.push(...arr);
    }
    return out;
  }

  private async resolveAssetId(path: string): Promise<string> {
    const np = normalizePath(path);
    if (np === "/") return this.rootId;
    let pid = this.rootId;
    for (const seg of np.split("/").filter(Boolean)) {
      const list = await this.getChildren(pid);
      const hit = list.find((a) => a.title === seg);
      if (!hit) throw new Error(`mediatrack: 目录不存在 ${path}`);
      pid = hit.id;
    }
    return pid;
  }

  async list(path: string): Promise<FileItem[]> {
    const pid = await this.resolveAssetId(path);
    const assets = await this.getChildren(pid);
    return assets.map((a) => ({
      name: a.title,
      path: joinPath(path, a.title),
      is_dir: a.file == null,
      size: Number(a.size || 0),
      modified: a.updated_at ? new Date(a.updated_at).getTime() : 0,
      etag: a.id,
    }));
  }

  async get(path: string): Promise<FileItem> {
    const pid = await this.resolveAssetId(parentPath(path));
    const assets = await this.getChildren(pid);
    const a = assets.find((x) => x.title === basename(path));
    if (!a) throw new Error("文件不存在");
    return {
      name: a.title, path, is_dir: a.file == null, size: Number(a.size || 0),
      modified: a.updated_at ? new Date(a.updated_at).getTime() : 0, etag: a.id,
    };
  }

  async getContent(path: string, _range?: string): Promise<Response | string> {
    const item = await this.get(path);
    const tokenUrl = `https://kayn.api.mediatrack.cn/v1/download_token/asset?asset_id=${item.etag}&source_type=project&password=&source_id=${encodeURIComponent(this.projectId)}`;
    const tok = await this.mtGet<any>(tokenUrl);
    const token = tok.data?.token;
    const r = await fetch(`https://kayn.api.mediatrack.cn/v1/download/redirect?token=${encodeURIComponent(token)}`, { redirect: "manual" });
    if (r.status === 302 && r.headers.get("location")) return r.headers.get("location") as string;
    return `https://kayn.api.mediatrack.cn/v1/download/redirect?token=${encodeURIComponent(token)}`;
  }

  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    // 无法给客户端预签名（COS 临时凭证需服务端 SigV4 签名），返回 Worker 代理上传
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(_path)}`, method: "PUT", headers: { "x-driver": "mediatrack" } };
  }

  async putContent(path: string, body: ReadableStream, contentType?: string, size = 0): Promise<void> {
    const pid = await this.resolveAssetId(parentPath(path));
    const name = basename(path);
    const src = "assets/" + crypto.randomUUID();
    const token = await this.mtGet<any>(`https://jayce.api.mediatrack.cn/v3/storage/tokens/asset?src=${encodeURIComponent(src)}`);
    const c = token.data.credentials;
    const bucket = token.data.bucket;
    const object = token.data.object;
    const region = token.data.region;
    const cosUrl = `https://${bucket}.cos.accelerate.myqcloud.com/${object}`;
    const auth = await signCos({
      url: cosUrl, method: "PUT", region,
      accessKey: c.TmpSecretID, secretKey: c.TmpSecretKey, sessionToken: c.Token,
      contentType: contentType || "application/octet-stream",
    });
    const up = await fetch(cosUrl, {
      method: "PUT",
      headers: { ...auth, "Content-Type": contentType || "application/octet-stream", "Content-Length": String(size) },
      body,
    });
    if (!up.ok) throw new Error(`mediatrack COS 上传 ${up.status}`);
    // 登记资产。hash 留空：流式上传无法在落盘前预计算 md5（Go 端靠缓存文件 seek 计算，Worker 端不缓冲整文件）
    await this.mtReq("POST", `https://jayce.api.mediatrack.cn/v3/assets/${pid}/children`, {
      category: 0,
      description: name,
      hash: "",
      mime: contentType || "application/octet-stream",
      size,
      src,
      title: name,
      type: 0,
    });
  }

  async mkdir(path: string): Promise<void> {
    const pid = await this.resolveAssetId(parentPath(path));
    await this.mtReq("POST", `https://jayce.api.mediatrack.cn/v3/assets/${pid}/children`, {
      type: 1,
      title: basename(path),
    });
  }

  async remove(path: string): Promise<void> {
    const originId = await this.resolveAssetId(parentPath(path));
    const id = (await this.get(path)).etag;
    await this.mtReq("DELETE", "https://jayce.api.mediatrack.cn/v4/assets/batch/delete", {
      origin_id: originId,
      ids: [id],
    });
  }

  async rename(from: string, to: string): Promise<void> {
    const id = (await this.get(from)).etag;
    await this.mtReq("PUT", `https://jayce.api.mediatrack.cn/v3/assets/${id}`, {
      title: basename(to),
    });
  }

  async move(from: string, to: string): Promise<void> {
    const dstId = await this.resolveAssetId(to);
    const id = (await this.get(from)).etag;
    await this.mtReq("POST", "https://jayce.api.mediatrack.cn/v4/assets/batch/move", {
      parent_id: dstId,
      ids: [id],
    });
  }
}

// AWS Signature V4（Tencent COS 兼容 S3 接口），用 Web Crypto 实现。
// 采用 UNSIGNED-PAYLOAD，避免缓冲整个请求体（CF Worker 不可缓冲整文件）。
async function signCos(opts: {
  url: string; method: string; region: string;
  accessKey: string; secretKey: string; sessionToken: string; contentType: string;
}): Promise<Record<string, string>> {
  const u = new URL(opts.url);
  const host = u.host;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const service = "s3";
  const scope = `${dateStamp}/${opts.region}/${service}/aws4_request`;

  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token";
  const payloadHash = "UNSIGNED-PAYLOAD";
  const canonicalHeaders =
    `content-type:${opts.contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-security-token:${opts.sessionToken}\n`;

  const canonicalUri = u.pathname || "/";
  const canonicalQuery = u.search.replace(/^\?/, "");
  const canonicalRequest =
    `${opts.method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const enc = new TextEncoder();
  const stringToSign =
    `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${toHex(await crypto.subtle.digest("SHA-256", enc.encode(canonicalRequest)))}`;

  const kDate = await hmac(enc.encode("AWS4" + opts.secretKey), dateStamp);
  const kRegion = await hmac(kDate, opts.region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  return {
    "Content-Type": opts.contentType,
    "Host": host,
    "X-Amz-Content-Sha256": payloadHash,
    "X-Amz-Date": amzDate,
    "X-Amz-Security-Token": opts.sessionToken,
    Authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function hmac(key: ArrayBufferView | ArrayBuffer, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", key as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
