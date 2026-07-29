import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, parentPath, registerDriver } from "./base";
import { CloudBase } from "./cloud-base";
import { md5Hex } from "../util/md5";

const UA = "terabox;1.37.0.7;PC;PC-Windows;10.0.22631;WindowsTeraBox";
const INITIAL_CHUNK = 4 << 20; // 4MB
const INITIAL_THRESHOLD = 4 << 30; // 4GB
const BOUND = "----EdgeOpenListTeraboxBoundary";

// 海外版 TeraBox（Cookie 登录态）。端点/签名/分片上传流程来自 OpenList drivers/terabox。
// 鉴权：Cookie；下载需 RC4-like sign() 经 /api/home/info 的 sign1/sign3 生成。
export class TeraboxDriver extends CloudBase {
  readonly id = "terabox";
  private cookie = "";
  private orderBy = "";
  private orderDirection = "asc";
  private downloadApi = "official";
  private jsToken = "";
  private urlDomainPrefix = "jp";
  private baseUrl = "https://www.terabox.com";

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.cookie = this.cfgStr("cookie") || "";
    this.orderBy = this.cfgStr("order_by") || "";
    this.orderDirection = this.cfgStr("order_direction") || "asc";
    this.downloadApi = this.cfgStr("download_api") || "official";
    this.baseUrl = "https://www.terabox.com";
    this.urlDomainPrefix = "jp";
    this.jsToken = "";
    const resp = await this.apiRequest("GET", "/api/check/login", null);
    if (resp.errno !== 0) {
      if (resp.errno === 9000) throw new Error("terabox: 该地区暂不可用");
      throw new Error("terabox: Cookie 登录校验失败");
    }
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return {
      Cookie: this.cookie,
      Accept: "application/json, text/plain, */*",
      Referer: this.baseUrl,
      "User-Agent": UA,
      "X-Requested-With": "XMLHttpRequest",
    };
  }

  // ---- 通用请求：附带 base query 参数与 Cookie；处理 jsToken 重置与 Url-Domain-Prefix 重定向 ----
  private async apiRequest(
    method: string,
    pathOrUrl: string,
    params?: Record<string, string> | null,
    body?: BodyInit | null,
    contentType?: string
  ): Promise<any> {
    const isFull = pathOrUrl.startsWith("https://");
    const fullUrl = isFull ? pathOrUrl : this.baseUrl + pathOrUrl;
    const qp = new URLSearchParams({
      app_id: "250528",
      web: "1",
      channel: "dubox",
      clienttype: "0",
      jsToken: this.jsToken,
      ...(params || {}),
    });
    const headers: Record<string, string> = await this.hdrs();
    if (contentType) headers["Content-Type"] = contentType;
    const r = await fetch(`${fullUrl}?${qp.toString()}`, { method, headers, body: body as any });
    const text = await r.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }
    const errno = json.errno;
    if (errno === 4000023 || errno === 450016) {
      await this.resetJsToken();
      return this.apiRequest(method, pathOrUrl, params, body, contentType);
    }
    if (errno === -6) {
      const prefix = r.headers.get("Url-Domain-Prefix");
      if (prefix) {
        this.urlDomainPrefix = prefix;
        this.baseUrl = `https://${prefix}.terabox.com`;
        return this.apiRequest(method, pathOrUrl, params, body, contentType);
      }
    }
    return json;
  }

  // 从主页 HTML 提取 jsToken（与 Go resetJsToken 一致）
  private async resetJsToken(): Promise<void> {
    const r = await fetch(this.baseUrl, { headers: await this.hdrs() });
    const html = await r.text();
    const start = "`function%20fn%28a%29%7Bwindow.jsToken%20%3D%20a%7D%3Bfn%28\"";
    const end = "%22%29`";
    const i = html.indexOf(start);
    if (i < 0) throw new Error("terabox: 未找到 jsToken");
    const j = html.indexOf(end, i + start.length);
    if (j < 0) throw new Error("terabox: 未找到 jsToken 结尾");
    this.jsToken = html.substring(i + start.length, j);
  }

  // ---- 路径列表 ----
  private async getFiles(dir: string): Promise<any[]> {
    const out: any[] = [];
    let page = 1;
    for (;;) {
      const params: Record<string, string> = { dir, page: String(page), num: "100" };
      if (this.orderBy) {
        params["order"] = this.orderBy;
        if (this.orderDirection === "desc") params["desc"] = "1";
      }
      const resp = await this.apiRequest("GET", "/api/list", params);
      if (resp.errno === 9000) throw new Error("terabox: 该地区暂不可用");
      const list: any[] = resp.list || [];
      if (list.length === 0) break;
      out.push(...list);
      if (list.length < 100) break;
      page++;
    }
    return out;
  }

  private toItem(f: any, baseDir: string): FileItem {
    return {
      name: f.server_filename,
      path: joinPath(baseDir, f.server_filename),
      is_dir: f.isdir === 1,
      size: Number(f.size || 0),
      modified: (Number(f.server_mtime) || 0) * 1000,
      etag: String(f.fs_id),
    };
  }

  async list(path: string): Promise<FileItem[]> {
    const files = await this.getFiles(path);
    return files.map((f) => this.toItem(f, path));
  }

  async get(path: string): Promise<FileItem> {
    if (path === "/") return { name: "", path: "/", is_dir: true, size: 0, modified: 0 };
    const parent = parentPath(path);
    const name = basename(path);
    const files = await this.getFiles(parent);
    const f = files.find((x) => x.server_filename === name);
    if (!f) throw new Error(`terabox: 不存在 ${path}`);
    return this.toItem(f, parent);
  }

  // ---- 下载链路 ----
  // RC4-like 签名（忠实移植 OpenList terabox/util.go sign）
  private sign(s1: string, s2: string): string {
    const a = new Array(256).fill(0);
    const p = new Array(256).fill(0);
    const v = s1.length;
    for (let q = 0; q < 256; q++) {
      a[q] = s1.charCodeAt(q % v) & 0xff;
      p[q] = q;
    }
    let u = 0;
    for (let q = 0; q < 256; q++) {
      u = (u + p[q] + a[q]) % 256;
      const t = p[q];
      p[q] = p[u];
      p[u] = t;
    }
    const out: number[] = [];
    let i = 0;
    u = 0;
    for (let q = 0; q < s2.length; q++) {
      i = (i + 1) % 256;
      u = (u + p[i]) % 256;
      const t = p[i];
      p[i] = p[u];
      p[u] = t;
      const k = p[(p[i] + p[u]) % 256];
      out.push((s2.charCodeAt(q) & 0xff) ^ k);
    }
    let bin = "";
    for (const byte of out) bin += String.fromCharCode(byte);
    return btoa(bin);
  }

  private async genSign(): Promise<string> {
    const resp = await this.apiRequest("GET", "/api/home/info", {});
    return this.sign(resp.data.sign3, resp.data.sign1);
  }

  private async linkOfficial(item: FileItem): Promise<string> {
    const signStr = await this.genSign();
    const params = {
      type: "dlink",
      fidlist: `[${item.etag}]`,
      sign: signStr,
      vip: "2",
      timestamp: String(Math.floor(Date.now() / 1000)),
    };
    const resp = await this.apiRequest("GET", "/api/download", params);
    if (!resp.dlink || resp.dlink.length === 0) {
      throw new Error(`terabox: 无下载链接, errno ${resp.errno}`);
    }
    const dlink = resp.dlink[0].dlink;
    const r = await fetch(dlink, { redirect: "manual", headers: { Cookie: this.cookie, "User-Agent": UA } });
    const loc = r.headers.get("location");
    if (!loc) throw new Error("terabox: dlink 无跳转地址");
    return loc;
  }

  private async linkCrack(item: FileItem): Promise<string> {
    const params = { target: `["${item.path}"]`, dlink: "1", origin: "dlna" };
    const resp = await this.apiRequest("GET", "/api/filemetas", params);
    if (!resp.info || resp.info.length === 0) throw new Error("terabox: 无下载链接(crack)");
    return resp.info[0].dlink;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const item = await this.get(path);
    const url = this.downloadApi === "crack" ? await this.linkCrack(item) : await this.linkOfficial(item);
    return fetch(url, { headers: { "User-Agent": UA, ...(range ? { Range: range } : {}) } });
  }

  // ---- 写操作 ----
  async mkdir(path: string): Promise<void> {
    const parent = parentPath(path);
    const full = joinPath(parent, basename(path));
    const data = new URLSearchParams({ path: full, isdir: "1", block_list: "[]" });
    await this.apiRequest("POST", "/api/create", { a: "commit" }, data.toString(), "application/x-www-form-urlencoded");
  }

  private async manage(opera: string, filelist: unknown): Promise<void> {
    const params = { onnest: "fail", opera };
    const marshal = JSON.stringify(filelist);
    const data = `async=0&filelist=${encodeURIComponentGo(marshal)}&ondup=newcopy`;
    await this.apiRequest("POST", "/api/filemanager", params, data, "application/x-www-form-urlencoded");
  }

  async remove(path: string): Promise<void> {
    await this.manage("delete", [path]);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.manage("rename", [{ path: from, newname: basename(to) }]);
  }

  async move(from: string, to: string): Promise<void> {
    await this.manage("move", [{ path: from, dest: parentPath(to), newname: basename(from) }]);
  }

  // ---- 上传：locateupload -> precreate -> superfile2 分片 -> create ----
  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "terabox" } };
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const parent = parentPath(path);
    const name = basename(path);

    // 1) locateupload（独立域名，无需 Cookie）
    const locResp = await fetch(`https://${this.urlDomainPrefix}-data.terabox.com/rest/2.0/pcs/file?method=locateupload`);
    const locJson = (await locResp.json()) as any;
    const host = locJson.host;
    if (!host) throw new Error("terabox: locateupload 未返回 host");

    // 2) precreate
    const blockList =
      size > INITIAL_CHUNK
        ? '["5910a591dd8fc18c32a8f3df4fdc1761","a5fc157d78e6ad1c7e114b056c92821e"]'
        : '["5910a591dd8fc18c32a8f3df4fdc1761"]';
    const preData = new URLSearchParams({
      path,
      autoinit: "1",
      target_path: parent,
      block_list: blockList,
      local_mtime: String(Math.floor(Date.now() / 1000)),
      file_limit_switch_v34: "true",
    });
    const pre = await this.apiRequest("POST", "/api/precreate", null, preData.toString(), "application/x-www-form-urlencoded");
    if (pre.errno !== 0) throw new Error(`terabox: precreate 失败 errno ${pre.errno}`);
    if (pre.return_type === 2) return; // 秒传命中

    // 3) 分片上传（流式读取，仅缓冲单个分片用于计算 MD5）
    const streamSize = size > 0 ? size : 0;
    const chunkSize = streamSize > 0 ? calculateChunkSize(streamSize) : INITIAL_CHUNK;
    const reader = new ByteReader(body);
    const uploadBlockList: string[] = [];
    const superUrl = `https://${host}/rest/2.0/pcs/superfile2`;
    let partseq = 0;
    for (;;) {
      const bytes = await reader.readExactly(chunkSize);
      if (!bytes || bytes.length === 0) break;
      const localMD5 = md5Hex(bytes);
      uploadBlockList.push(localMD5);
      const params = {
        method: "upload",
        path: encodeURIComponentGo(path),
        uploadid: pre.uploadid,
        partseq: String(partseq),
      };
      const mp = multipartFile("file", name, bytes);
      let ok = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        const resp = await this.apiRequest("POST", superUrl, params, mp, `multipart/form-data; boundary=${BOUND}`);
        if (resp.md5 === localMD5) {
          ok = true;
          break;
        }
      }
      if (!ok) throw new Error(`terabox: 分片 ${partseq} MD5 校验失败`);
      partseq++;
    }
    reader.cancel();

    // 4) create 完成提交
    const createData = new URLSearchParams({
      path,
      size: String(size),
      uploadid: pre.uploadid,
      target_path: parent,
      block_list: JSON.stringify(uploadBlockList),
      local_mtime: String(Math.floor(Date.now() / 1000)),
    });
    const createResp = await this.apiRequest(
      "POST",
      "/api/create",
      { isdir: "0", rtype: "1" },
      createData.toString(),
      "application/x-www-form-urlencoded"
    );
    if (createResp.errno !== 0) throw new Error(`terabox: create 失败 errno ${createResp.errno}`);
  }
}

// ---- 辅助 ----
function encodeURIComponentGo(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function calculateChunkSize(streamSize: number): number {
  let chunkSize = INITIAL_CHUNK;
  let threshold = INITIAL_THRESHOLD;
  if (streamSize < chunkSize) return streamSize;
  while (streamSize > threshold) {
    chunkSize <<= 1;
    threshold <<= 1;
  }
  return chunkSize;
}

// 从 ReadableStream 精确读取 n 字节（保留剩余在内部缓冲）
class ByteReader {
  private buf = new Uint8Array(0);
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(stream: ReadableStream) {
    this.reader = stream.getReader();
  }
  async readExactly(n: number): Promise<Uint8Array | null> {
    while (this.buf.length < n) {
      const { done, value } = await this.reader.read();
      if (done) break;
      const v = value as Uint8Array;
      if (!v || v.length === 0) continue;
      const nb = new Uint8Array(this.buf.length + v.length);
      nb.set(this.buf, 0);
      nb.set(v, this.buf.length);
      this.buf = nb;
    }
    if (this.buf.length === 0) return null;
    const take = Math.min(n, this.buf.length);
    const out = this.buf.subarray(0, take);
    this.buf = this.buf.subarray(take);
    return out;
  }
  cancel(): void {
    this.reader.cancel().catch(() => {});
  }
}

function multipartFile(field: string, filename: string, bytes: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const head = enc.encode(`--${BOUND}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = enc.encode(`\r\n--${BOUND}--\r\n`);
  const out = new Uint8Array(head.length + bytes.length + tail.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  out.set(tail, head.length + bytes.length);
  return out;
}

registerDriver("terabox", TeraboxDriver);

export type _Avoid = Env | DriverConfig;
