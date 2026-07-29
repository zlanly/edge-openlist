import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";

// 豆包(旧版)。Cookie 鉴权。列表/下载走 /samantha/aispace、/alice、/samantha/media。
// 上传走字节火山 imagex / vod，使用 AWS SigV4 签名直传（读取流以计算 CRC32，属已知偏差）。
const BASE_URL = "https://www.doubao.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const REGION = "cn-north-1";
const DEFAULT_CHUNK = 5 * 1024 * 1024;
const MAX_RETRY = 3;

// ---- CRC32 (IEEE) ----
const CRC_TAB = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes: Uint8Array): string {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TAB[(c ^ b) & 0xff] ^ (c >>> 8);
  c = (c ^ 0xffffffff) >>> 0;
  const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, c, false);
  return Array.from(out).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function sha256hex(data: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(h));
}
async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const ck = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", ck, new TextEncoder().encode(data)));
}
function urlEnc(s: string): string { return encodeURIComponent(s).replace(/\+/g, "%20"); }

// AWS SigV4（对齐 doubao.go signRequest）。headers 会被原地补充签名头。
async function signV4(method: string, urlStr: string, headers: Record<string, string>, body: Uint8Array | null, ak: string, sk: string, service: string): Promise<void> {
  const u = new URL(urlStr);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const bodyHash = body ? await sha256hex(body) : await sha256hex(new Uint8Array(0));
  headers["X-Amz-Date"] = amzDate;
  headers["X-Amz-Content-Sha256"] = bodyHash;
  if (headers["X-Amz-Security-Token"]) { /* keep */ }
  // canonical query
  const qp = new URLSearchParams(u.search);
  const qkeys = [...qp.keys()].sort();
  const cq = qkeys.map((k) => `${urlEnc(k)}=${urlEnc(qp.get(k)!)}`).join("&");
  // canonical headers
  const unsignable = new Set(["authorization", "content-type", "content-length", "user-agent", "presigned-expires", "expect", "x-amzn-trace-id"]);
  const lowerIn: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (v) lowerIn[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  const signed = Object.keys(lowerIn).filter((k) => k.startsWith("x-amz-") || !unsignable.has(k)).sort();
  const ch = signed.map((k) => `${k}:${lowerIn[k]}\n`).join("");
  const signedHeaders = signed.join(";");
  const canonicalURI = u.pathname || "/";
  const creq = `${method}\n${canonicalURI}\n${cq}\n${ch}\n${signedHeaders}\n${bodyHash}`;
  const creqHash = await sha256hex(new TextEncoder().encode(creq));
  const scope = `${dateStamp}/${REGION}/${service}/aws4_request`;
  const sts = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${creqHash}`;
  let kDate = await hmac(new TextEncoder().encode("AWS4" + sk), dateStamp);
  let kRegion = await hmac(kDate, REGION);
  let kSvc = await hmac(kRegion, service);
  let kSign = await hmac(kSvc, "aws4_request");
  const sig = bytesToHex(await hmac(kSign, sts));
  headers["Authorization"] = `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DoubaoDriver extends CloudBase {
  readonly id = "doubao";
  private userId = "";
  private idCache = new Map<string, string>();

  private cfgStr(k: string): string { return (this.cfg as Record<string, unknown>)[k] as string; }
  private get downloadApi(): string { return this.cfgStr("download_api") || "get_file_url"; }

  protected async hdrs(): Promise<Record<string, string>> {
    return { Cookie: this.cfgStr("cookie") || "", "User-Agent": USER_AGENT };
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    const r: any = await this.jsonGet(`${BASE_URL}/passport/account/info/v2/`);
    this.userId = String(r.data?.user_id ?? r.data?.user_id_str ?? "");
  }

  private async request(path: string, method: string, body?: unknown): Promise<any> {
    const r = await fetch(BASE_URL + path, {
      method,
      headers: { Cookie: this.cfgStr("cookie") || "", "User-Agent": USER_AGENT, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) throw new Error(`doubao ${r.status} ${path}`);
    const j = (await r.json()) as any;
    if (j.code !== 0) throw new Error(`doubao API ${j.code}: ${j.msg || j.message}`);
    return j;
  }

  private async resolveFolderId(path: string): Promise<string> {
    if (path === "/") return "0";
    if (this.idCache.has(path)) return this.idCache.get(path)!;
    const parts = path.split("/").filter(Boolean);
    let id = "0"; let cur = "/";
    for (const p of parts) {
      cur = joinPath(cur, p);
      if (this.idCache.has(cur)) { id = this.idCache.get(cur)!; continue; }
      const items = await this.listByFolder(id);
      const it = items.find((i) => i.name === p && i.is_dir);
      if (!it) throw new Error(`doubao 目录不存在: ${cur}`);
      id = it.etag!; this.idCache.set(cur, id);
    }
    return id;
  }

  private async getFiles(dirId: string, cursor = ""): Promise<any[]> {
    const body: any = { node_id: dirId };
    if (cursor) { body.cursor = cursor; body.size = 50; } else body.need_full_path = false;
    const r: any = await this.request("/samantha/aispace/node_info", "POST", body);
    let children = r.data?.children || [];
    if (r.data?.next_cursor && r.data.next_cursor !== "-1") {
      children = children.concat(await this.getFiles(dirId, r.data.next_cursor));
    }
    return children;
  }

  private async listByFolder(folderId: string): Promise<FileItem[]> {
    const files = await this.getFiles(folderId);
    return files.map((f: any) => ({
      name: f.name, path: "", is_dir: f.node_type === 1, size: Number(f.size || 0),
      modified: (Number(f.update_time) || 0) * 1000, etag: f.id,
    }));
  }

  async list(path: string): Promise<FileItem[]> {
    const id = await this.resolveFolderId(path);
    const raw = await this.listByFolder(id);
    return raw.map((i) => ({ ...i, path: joinPath(path, i.name) }));
  }

  async get(path: string): Promise<FileItem> {
    if (path === "/") return { name: "", path: "/", is_dir: true, size: 0, modified: 0 };
    const items = await this.list(parentPath(path));
    const it = items.find((i) => i.path === path);
    if (!it) throw new Error(`doubao 文件不存在: ${path}`);
    return it;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const it = await this.get(path);
    if (it.is_dir) throw new Error("doubao 目录不可下载");
    let url = "";
    if (this.downloadApi === "get_download_info") {
      const r: any = await this.request("/samantha/aispace/get_download_info", "POST", { requests: [{ node_id: it.etag }] });
      url = r.data?.download_infos?.[0]?.main_url;
    } else if (it.etag && (await this.isMedia(it.etag))) {
      const r: any = await this.request("/samantha/media/get_play_info", "POST", { key: "", node_id: it.etag });
      url = r.data?.original_media_info?.main_url;
    } else {
      const r: any = await this.request("/alice/message/get_file_url", "POST", { uris: [""], type: "file" });
      url = r.data?.file_urls?.[0]?.main_url;
    }
    if (!url) throw new Error("doubao 获取下载链失败");
    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    if (range) { headers["Range"] = range; return fetch(url, { headers }); }
    return url;
  }

  // 简化：若 downloadApi=get_file_url 且文件名疑似媒体则尝试 get_play_info（实际 key 需上游）
  private async isMedia(_id: string): Promise<boolean> { return false; }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "doubao" } };
  }

  // 完整上传流程（imagex/vod SigV4）。注意：为计算 CRC32 需先读取整个流（已知偏差）。
  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const parentId = await this.resolveFolderId(parentPath(path));
    const name = basename(path);
    const buf = new Uint8Array(await new Response(body).arrayBuffer());
    const totalSize = size || buf.length;
    const mime = this.cfgStr("mime") || "application/octet-stream";
    let dataType = "file";
    if (mime.startsWith("video/") || mime.startsWith("audio/")) dataType = "video";
    else if (mime.startsWith("image/")) dataType = "image";

    // 1. 获取上传令牌
    const fileTok: any = await this.request("/alice/upload/auth_token", "POST", { scene: "bot_chat", data_type: dataType === "video" ? "file" : dataType });
    const alice = fileTok.data;
    let sampa: any = null; let service: string; let host: string;
    if (dataType === "video") {
      const m: any = await this.request("/samantha/media/get_upload_token", "POST", {});
      sampa = m.data; service = "vod"; host = sampa.upload_info.video_host;
    } else { service = "imagex"; host = alice.upload_host; }

    // 2. 获取上传配置
    const params: Record<string, string> = { Action: dataType === "video" ? "ApplyUploadInner" : "ApplyImageUpload", Version: dataType === "video" ? "2020-11-19" : "2018-08-01", s: Math.random().toString(36).slice(2, 13) };
    if (dataType === "video") { params.SpaceName = sampa.upload_info.space_name; params.FileType = "video"; params.IsInner = "1"; params.NeedFallback = "true"; params.FileSize = String(totalSize); }
    else { params.ServiceId = alice.service_id; params.NeedFallback = "true"; params.FileSize = String(totalSize); params.FileExtension = ""; }
    const cfgUrl = dataType === "video" ? host : `https://${host}`;
    const cfgHeaders: Record<string, string> = { "user-agent": USER_AGENT };
    if (dataType === "video") await signV4("GET", cfgUrl, cfgHeaders, null, sampa.sts_token.access_key_id, sampa.sts_token.secret_access_key, "vod");
    else await signV4("GET", cfgUrl, cfgHeaders, null, alice.auth.access_key_id, alice.auth.secret_access_key, "imagex");
    const cfgu = new URL(cfgUrl); for (const [k, v] of Object.entries(params)) cfgu.searchParams.set(k, v);
    const cRes = await fetch(cfgu.toString(), { headers: cfgHeaders });
    const cfgJson: any = await cRes.json();
    const upCfg = cfgJson.Result;
    const node = upCfg.InnerUploadAddress.UploadNodes[0];
    const storeInfo = node.StoreInfos[0];
    const uploadUrl = `https://${node.UploadHost}/upload/v1/${storeInfo.StoreURI}`;
    const crc = crc32(buf);

    const upHeaders: Record<string, string> = {
      Referer: BASE_URL + "/", Origin: BASE_URL, "User-Agent": USER_AGENT,
      "X-Storage-U": this.userId, Authorization: storeInfo.auth,
      "Content-Type": "application/octet-stream", "Content-Crc32": crc,
      "Content-Length": String(buf.length),
      "Content-Disposition": `attachment; filename=${encodeURIComponent(storeInfo.StoreURI)}`,
    };

    if (buf.length <= DEFAULT_CHUNK) {
      await this.doUpload(uploadUrl, upHeaders, buf, crc);
    } else {
      // 分片
      const initR = await fetch(uploadUrl + `?uploadmode=part&phase=init`, { method: "POST", headers: upHeaders });
      const initJ: any = await initR.json();
      if (initJ.code !== 2000) throw new Error(`doubao init upload 失败: ${initJ.message}`);
      const uploadId = initJ.data.uploadid;
      let offset = 0; let part = 1;
      while (offset < buf.length) {
        const slice = buf.slice(offset, offset + DEFAULT_CHUNK);
        const ph = { ...upHeaders };
        const pu = new URL(uploadUrl); pu.searchParams.set("uploadid", uploadId); pu.searchParams.set("part_number", String(part)); pu.searchParams.set("phase", "transfer");
        await this.doUpload(pu.toString(), ph, slice, crc32(slice));
        offset += slice.length; part++;
      }
      const fin = new URL(uploadUrl); fin.searchParams.set("uploadid", uploadId); fin.searchParams.set("phase", "finish"); fin.searchParams.set("uploadmode", "part");
      await fetch(fin.toString(), { method: "POST", headers: upHeaders });
      if (dataType === "video") {
        // CommitUploadInner
        const ch: Record<string, string> = { "user-agent": USER_AGENT, "Content-Type": "application/json" };
        await signV4("POST", host, ch, new TextEncoder().encode(JSON.stringify({ SessionKey: node.session_key, Functions: [] })),
          sampa.sts_token.access_key_id, sampa.sts_token.secret_access_key, "vod");
        const cu = new URL(host); cu.searchParams.set("Action", "CommitUploadInner"); cu.searchParams.set("Version", "2020-11-19"); cu.searchParams.set("SpaceName", sampa.upload_info.space_name);
        await fetch(cu.toString(), { method: "POST", headers: ch, body: JSON.stringify({ SessionKey: node.session_key, Functions: [] }) });
      }
    }

    // 3. 登记节点
    let key = storeInfo.store_uri; let nodeType = dataType === "image" ? 4 : dataType === "video" ? 6 : 2;
    if (dataType === "video") key = node.vid;
    await this.request("/samantha/aispace/upload_node", "POST", {
      node_list: [{ local_id: crypto.randomUUID(), parent_id: parentId, name, key, node_content: {}, node_type: nodeType, size: buf.length }],
      request_id: crypto.randomUUID(),
    });
  }

  private async doUpload(url: string, headers: Record<string, string>, data: Uint8Array, crc: string): Promise<void> {
    let lastErr = "";
    for (let i = 0; i < MAX_RETRY; i++) {
      try {
        const r = await fetch(url, { method: "POST", headers, body: data });
        const j: any = await r.json().catch(() => ({}));
        if (j.code !== 2000) { lastErr = `upload 失败: ${j.message}`; await sleep(500); continue; }
        if (j.data?.crc32 && j.data.crc32 !== crc) { lastErr = "crc32 不匹配"; await sleep(500); continue; }
        return;
      } catch (e) { lastErr = String(e); await sleep(500); }
    }
    throw new Error(`doubao ${lastErr}`);
  }

  async mkdir(path: string): Promise<void> {
    const parentId = await this.resolveFolderId(parentPath(path));
    await this.request("/samantha/aispace/upload_node", "POST", {
      node_list: [{ local_id: crypto.randomUUID(), name: basename(path), parent_id: parentId, node_type: 1 }],
    });
  }

  async remove(path: string): Promise<void> {
    const it = await this.get(path);
    await this.request("/samantha/aispace/delete_node", "POST", { node_list: [{ id: it.etag }] });
  }

  async rename(from: string, to: string): Promise<void> {
    const it = await this.get(from);
    await this.request("/samantha/aispace/rename_node", "POST", { node_id: it.etag, node_name: basename(to) });
  }

  async move(from: string, to: string): Promise<void> {
    const it = await this.get(from);
    const dest = await this.resolveFolderId(parentPath(to));
    await this.request("/samantha/aispace/move_node", "POST", {
      node_list: [{ id: it.etag }], current_parent_id: it.path, target_parent_id: dest,
    });
  }
}

