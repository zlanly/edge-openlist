import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, parentPath, registerDriver } from "./base";
import { CloudBase } from "./cloud-base";
import { md5Hex } from "../util/md5";

const UA = "terabox;1.37.0.7;PC;PC-Windows;10.0.22631;WindowsTeraBox";
const INITIAL_CHUNK = 4 << 20; // 4MB
const INITIAL_THRESHOLD = 4 << 30; // 4GB
const BOUND = "----EdgeOpenListTeraboxBoundary";

// ---- 免费档护栏 ----
// Workers 单次请求的 subrequest 上限是 50（免费档）。原实现里
// apiRequest 会无上限自递归、getFiles 会无上限翻页，任何一处失控都会撞上限，
// 请求被运行时直接掐断 —— 前端表现就是「点了没反应，一直转圈」。
const MAX_RETRY_DEPTH = 3; // jsToken 重置 / 域名重定向的重试深度
const MAX_PAGES = 20; // 单目录最多翻 20 页
const PAGE_SIZE = 100;
const MAX_ITEMS = MAX_PAGES * PAGE_SIZE;
/** jsToken 与域名前缀的 KV 缓存时长；避免每次请求都去抓一遍首页 HTML。 */
const TOKEN_TTL_S = 20 * 60;

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
  /** jsToken 刷新是否已失败过。失败后不再反复抓首页，直接带现有令牌重试一次兜底。 */
  private tokenRefreshFailed = false;

  private cfgStr(k: string): string {
    return (this.cfg as Record<string, unknown>)[k] as string;
  }

  private get cacheKey(): string {
    return `terabox:sess:${this.mountId}`;
  }

  private get kv(): KVNamespace | null {
    const kv = this.env?.KV;
    return kv && typeof kv.get === "function" ? kv : null;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.cookie = this.cfgStr("cookie") || "";
    if (!this.cookie) throw new Error("terabox: 未配置 Cookie，请到管理后台填写");
    this.orderBy = this.cfgStr("order_by") || "";
    this.orderDirection = this.cfgStr("order_direction") || "asc";
    this.downloadApi = this.cfgStr("download_api") || "official";
    this.baseUrl = "https://www.terabox.com";
    this.urlDomainPrefix = "jp";
    this.jsToken = "";

    // 令牌优先级：手动配置 > Cookie 自带 > KV 缓存 > 现取。
    // 浏览器会话 Cookie 里本来就带 jsToken 项，直接解析出来最可靠——
    // 抓首页 HTML 在风控/区域跳转/页面改版下都可能拿不到（表现为 4000023 死循环）。
    const fromCfg = (this.cfgStr("js_token") || "").trim();
    const fromCookie = this.jsTokenFromCookie();
    if (fromCfg) this.jsToken = fromCfg;
    else if (fromCookie) this.jsToken = fromCookie;

    // 原实现每次构造驱动都同步打一次 /api/check/login：
    // 列个目录要 2 次往返，点开一个文件要 4 次，白白吃掉延迟和 subrequest 配额。
    // 改为从 KV 复用上次的域名前缀，只有在真正调用 API 且被上游
    // 判定令牌失效（errno 4000023/450016）时才现取 —— 少一次强制往返。
    const cached = await this.loadSession();
    if (cached) {
      if (!this.jsToken && cached.jsToken) this.jsToken = cached.jsToken;
      if (cached.prefix) {
        this.urlDomainPrefix = cached.prefix;
        this.baseUrl = `https://${cached.prefix}.terabox.com`;
      }
      return;
    }

    const resp = await this.apiRequest("GET", "/api/check/login", null);
    if (resp.errno !== 0) {
      if (resp.errno === 9000) throw new Error("terabox: 该地区暂不可用");
      throw new Error("terabox: Cookie 登录校验失败，请到管理后台更新 Cookie");
    }
    await this.saveSession();
  }

  /** 从会话 Cookie 里解析 jsToken 项（浏览器复制的 Cookie 通常自带）。 */
  private jsTokenFromCookie(): string {
    const m = this.cookie.match(/(?:^|;\s*)jsToken=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  private async loadSession(): Promise<{ jsToken: string; prefix: string } | null> {
    const kv = this.kv;
    if (!kv) return null;
    try {
      const raw = await kv.get(this.cacheKey);
      if (!raw) return null;
      const v = JSON.parse(raw) as { jsToken?: string; prefix?: string; cookieHash?: string };
      // Cookie 换了就让缓存失效，否则会一直拿旧账号的令牌打上游
      if (v.cookieHash !== this.cookieHash()) return null;
      return { jsToken: v.jsToken || "", prefix: v.prefix || "" };
    } catch {
      return null;
    }
  }

  private async saveSession(): Promise<void> {
    const kv = this.kv;
    if (!kv) return;
    try {
      await kv.put(
        this.cacheKey,
        JSON.stringify({ jsToken: this.jsToken, prefix: this.urlDomainPrefix, cookieHash: this.cookieHash() }),
        { expirationTtl: TOKEN_TTL_S }
      );
    } catch {
      // KV 写失败不影响本次请求
    }
  }

  /** Cookie 指纹（不落明文到 KV）。 */
  private cookieHash(): string {
    return md5Hex(new TextEncoder().encode(this.cookie));
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
    contentType?: string,
    depth = 0
  ): Promise<any> {
    // 递归深度上限：原实现在 jsToken 一直取不到（Cookie 失效）时会无限自递归，
    // 每层还要多打一次首页 HTML，直到撞上 subrequest / CPU 上限被运行时杀掉。
    if (depth > MAX_RETRY_DEPTH) {
      throw new Error("terabox: 多次重试后仍无法通过令牌校验，请更新 Cookie");
    }

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

    let r: Response;
    try {
      r = await fetch(`${fullUrl}?${qp.toString()}`, { method, headers, body: body as any });
    } catch (e) {
      throw new Error(`terabox: 网络请求失败 ${e instanceof Error ? e.message : String(e)}`);
    }

    const text = await r.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      // 上游返回 HTML（通常是被风控挡了登录页）时，原实现静默当成 {}，
      // 于是 errno===undefined，列表返回空 —— 用户看到「文件夹是空的」而不是错误提示。
      if (!r.ok) throw new Error(`terabox: 上游返回 ${r.status}`);
      throw new Error("terabox: 上游返回了非 JSON 响应（Cookie 可能已失效）");
    }

    const errno = json.errno;
    if (errno === 4000023 || errno === 450016) {
      // 上游经常把新的 jsToken 直接塞在错误响应体里（网页端就是靠这个自愈的），
      // 有就直接换，省掉一次首页抓取——这也是「列表报错但其他接口正常」的常见情形。
      if (typeof json.jsToken === "string" && json.jsToken && json.jsToken !== this.jsToken) {
        this.jsToken = json.jsToken;
        await this.saveSession();
        return this.apiRequest(method, pathOrUrl, params, body, contentType, depth + 1);
      }
      // 再试 Cookie 里自带的令牌：手动配置/缓存的令牌过期时它往往还是有效的
      const fromCookie = this.jsTokenFromCookie();
      if (fromCookie && fromCookie !== this.jsToken) {
        this.jsToken = fromCookie;
        await this.saveSession();
        return this.apiRequest(method, pathOrUrl, params, body, contentType, depth + 1);
      }
      if (!this.tokenRefreshFailed) {
        this.tokenRefreshFailed = !(await this.resetJsToken());
        await this.saveSession();
        // 刷新失败也带现有令牌（可能为空）再试最后一次：
        // 实测不少接口并不严格校验 jsToken，空令牌也能过。
        return this.apiRequest(method, pathOrUrl, params, body, contentType, depth + 1);
      }
      throw new Error("terabox: 无法通过 jsToken 校验，且首页未返回令牌，Cookie 可能已失效");
    }
    if (errno === -6) {
      const prefix = r.headers.get("Url-Domain-Prefix");
      if (prefix && prefix !== this.urlDomainPrefix) {
        this.urlDomainPrefix = prefix;
        this.baseUrl = `https://${prefix}.terabox.com`;
        await this.saveSession();
        return this.apiRequest(method, pathOrUrl, params, body, contentType, depth + 1);
      }
      // 拿不到新前缀（或前缀没变）就别再转圈了，直接报错
      throw new Error("terabox: 账号所在区域需要切换域名，但上游未提供目标域名");
    }
    return json;
  }

  // 从主页 HTML 提取 jsToken（与 Go resetJsToken 一致）。
  // 改为「尽力而为」：取不到返回 false 而不是抛错 —— 不少接口对空令牌并不严格，
  // 原实现一抛错整个挂载就瘫痪，表现为「列表打不开但个别接口又正常」。
  private async resetJsToken(): Promise<boolean> {
    let r: Response;
    try {
      r = await fetch(this.baseUrl, { headers: await this.hdrs() });
    } catch {
      return false;
    }
    if (!r.ok) return false;
    const html = await r.text();
    // 主模式：URL 编码的 fn("...") 注入脚本
    const start = "`function%20fn%28a%29%7Bwindow.jsToken%20%3D%20a%7D%3Bfn%28\"";
    const end = "%22%29`";
    const i = html.indexOf(start);
    if (i >= 0) {
      const j = html.indexOf(end, i + start.length);
      if (j > i) {
        this.jsToken = html.substring(i + start.length, j);
        return true;
      }
    }
    // 备选模式：首页版本不同时令牌可能以未编码形式出现在页面里
    for (const [s, e] of [
      ['window.jsToken = "', '"'],
      ["window.jsToken = '", "'"],
      ['"jsToken":"', '"'],
    ] as const) {
      const k = html.indexOf(s);
      if (k >= 0) {
        const m = html.indexOf(e, k + s.length);
        if (m > k && m - k - s.length < 256) {
          this.jsToken = html.substring(k + s.length, m);
          return true;
        }
      }
    }
    return false;
  }

  // ---- 路径列表 ----
  private async getFiles(dir: string): Promise<any[]> {
    const out: any[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const params: Record<string, string> = { dir, page: String(page), num: String(PAGE_SIZE) };
      if (this.orderBy) {
        params["order"] = this.orderBy;
        if (this.orderDirection === "desc") params["desc"] = "1";
      }
      const resp = await this.apiRequest("GET", "/api/list", params);
      if (resp.errno === 9000) throw new Error("terabox: 该地区暂不可用");
      // errno 非 0 必须抛错。原实现直接读 resp.list（undefined -> []），
      // 把「Cookie 失效」「目录不存在」统统显示成「空文件夹」。
      if (resp.errno !== 0 && resp.errno !== undefined) {
        throw new Error(`terabox: 列目录失败 errno ${resp.errno}`);
      }
      const list: any[] = Array.isArray(resp.list) ? resp.list : [];
      out.push(...list);
      if (list.length < PAGE_SIZE) return out;
      if (out.length >= MAX_ITEMS) break;
    }
    // 触顶说明目录条目实在太多；截断总比撞 subrequest 上限被掐断要好
    console.warn(`terabox: 目录 ${dir} 条目超过 ${MAX_ITEMS}，已截断`);
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
    // 上游文件名是 NFD 分解形式（韩文/带音标的名字尤其明显），
    // 客户端传来的可能是 NFC —— 两种规范化都试，否则「列表里明明有却说不存在」
    const f =
      files.find((x) => x.server_filename === name) ||
      files.find((x) => x.server_filename.normalize("NFC") === name.normalize("NFC"));
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
    // resp.data 缺失时原实现会抛 "Cannot read properties of undefined"，
    // 一路冒泡成裸 500，用户完全看不出是网盘凭据的问题。
    const d = resp?.data;
    if (!d || typeof d.sign3 !== "string" || typeof d.sign1 !== "string") {
      throw new Error(`terabox: 获取下载签名失败（errno ${resp?.errno ?? "unknown"}），Cookie 可能已失效`);
    }
    return this.sign(d.sign3, d.sign1);
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
    if (!loc) {
      // 上游有时直接 200 返回内容（小文件），这时 dlink 本身就能用
      if (r.status === 200) return dlink;
      throw new Error(`terabox: 获取直链失败（上游 ${r.status}）`);
    }
    return loc;
  }

  private async linkCrack(item: FileItem): Promise<string> {
    const params = { target: JSON.stringify([item.path]), dlink: "1", origin: "dlna" };
    const resp = await this.apiRequest("GET", "/api/filemetas", params);
    const dlink = resp?.info?.[0]?.dlink;
    if (!dlink) throw new Error(`terabox: 无下载链接（errno ${resp?.errno ?? "unknown"}）`);
    return dlink;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const item = await this.get(path);
    const url = this.downloadApi === "crack" ? await this.linkCrack(item) : await this.linkOfficial(item);
    // 直链落地页还要校验账号 Cookie，缺了就回 {"errmsg":"need verify", errno:400141}
    // 并把 JSON 当正文返回。内容是本站代理转发，带上 Cookie 不会外泄。
    return fetch(url, {
      headers: { "User-Agent": UA, Cookie: this.cookie, ...(range ? { Range: range } : {}) },
    });
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

    // TeraBox 的 precreate 必须收到本次文件每个分片的真实 MD5，不能使用固定占位值。
    // 因为 MD5 列表在 precreate 之前就要提交，Worker 只能先暂存分片；之后逐片上传，
    // 避免中文文件名或任意内容在 precreate 阶段被上游直接判为非法。
    const chunkSize = size > 0 ? calculateChunkSize(size) : INITIAL_CHUNK;
    const chunks = await readChunks(body, chunkSize);
    const uploadBlockList = chunks.map((bytes) => md5Hex(bytes));
    const actualSize = chunks.reduce((total, bytes) => total + bytes.length, 0);
    if (size > 0 && actualSize !== size) {
      throw new Error(`terabox: 上传大小不一致（声明 ${size}，实际 ${actualSize}）`);
    }

    // 1) locateupload（独立域名，无需 Cookie）
    const locResp = await fetch(`https://${this.urlDomainPrefix}-data.terabox.com/rest/2.0/pcs/file?method=locateupload`);
    if (!locResp.ok) throw new Error(`terabox: locateupload 失败（HTTP ${locResp.status}）`);
    const locJson = (await locResp.json()) as any;
    const host = locJson.host;
    if (!host) throw new Error("terabox: locateupload 未返回 host");

    // 2) precreate：提交真实分片 MD5 列表
    const preData = new URLSearchParams({
      path,
      autoinit: "1",
      target_path: parent,
      block_list: JSON.stringify(uploadBlockList),
      local_mtime: String(Math.floor(Date.now() / 1000)),
      file_limit_switch_v34: "true",
    });
    const pre = await this.apiRequest("POST", "/api/precreate", null, preData.toString(), "application/x-www-form-urlencoded");
    if (pre.errno !== 0) throw new Error(`terabox: precreate 失败 errno ${pre.errno}`);
    if (pre.return_type === 2) return; // 秒传命中

    // 3) 分片上传。每次只构造当前分片的 multipart 请求，避免再次拼接整文件。
    const superUrl = `https://${host}/rest/2.0/pcs/superfile2`;
    for (let partseq = 0; partseq < chunks.length; partseq++) {
      const bytes = chunks[partseq];
      const localMD5 = uploadBlockList[partseq];
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
    }

    // 4) create 完成提交
    const createData = new URLSearchParams({
      path,
      size: String(actualSize),
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

async function readChunks(stream: ReadableStream, chunkSize: number): Promise<Uint8Array[]> {
  const reader = new ByteReader(stream);
  const chunks: Uint8Array[] = [];
  for (;;) {
    const chunk = await reader.readExactly(chunkSize);
    if (!chunk || chunk.length === 0) break;
    chunks.push(new Uint8Array(chunk));
  }
  reader.cancel();
  return chunks;
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
