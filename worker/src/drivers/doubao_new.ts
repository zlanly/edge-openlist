import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { CloudBase } from "./cloud-base";
import { loadTokens, saveTokens, type TokenSet } from "../util/tokenstore";

const BASE_URL = "https://my.feishu.cn";
const DOWNLOAD_BASE_URL = "https://internal-api-drive-stream.feishu.cn";
const DOUBAO_URL = "https://www.doubao.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const OBJ_TYPES = ["124", "0", "12", "30", "123", "22"];

// ---------- 通用工具 ----------
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64std(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64urlDecode(s: string): string {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}
function getCookie(cookie: string, name: string): string {
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1].trim() : "";
}
function trimScheme(t: string): string {
  t = (t || "").trim();
  const i = t.indexOf(" ");
  if (i > 0) {
    const s = t.slice(0, i).toLowerCase();
    if (s === "bearer" || s === "dpop") return t.slice(i + 1).trim();
  }
  return t;
}
function normalizeUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.toString();
  } catch {
    return u;
  }
}
function jwtExp(token: string): number {
  const p = token.split(".");
  if (p.length < 2) return 0;
  try {
    const o = JSON.parse(b64urlDecode(p[1]));
    return o.exp || 0;
  } catch {
    return 0;
  }
}
function shouldRefresh(token: string): boolean {
  if (!token) return true;
  const exp = jwtExp(token);
  if (exp <= 0) return false;
  return exp <= Math.floor(Date.now() / 1000) + 120;
}
function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % MOD;
    b = (b + a) % MOD;
  }
  return (b << 16) | a;
}
function parseSize(s: string): number {
  if (!s) return 0;
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
}

// ---------- DPoP (ES256) ----------
interface NodeT {
  token: string;
  node_token: string;
  obj_token: string;
  name: string;
  type: number;
  node_type: number;
  create_time: number;
  edit_time: number;
  url: string;
  extra: { size: string };
}

async function genDpop(key: CryptoKey, htm: string, htu: string): Promise<string> {
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as any;
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } };
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    jti: crypto.randomUUID(),
    htm: htm.toUpperCase(),
    htu,
    iat,
    nonce: crypto.randomUUID(),
    exp: iat + 15,
  };
  const h = b64url(new TextEncoder().encode(JSON.stringify(header)));
  const p = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = h + "." + p;
  const sigBuf = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput));
  const sig = new Uint8Array(sigBuf);
  return signingInput + "." + b64url(sig);
}

async function importDpopKeyPair(encrypted: string, secret: string): Promise<CryptoKey> {
  let ciphertextB64 = encrypted.trim();
  try {
    const obj = JSON.parse(encrypted);
    if (obj.data) ciphertextB64 = obj.data;
    else if (obj.ciphertext) ciphertextB64 = obj.ciphertext;
    else if (obj.encrypted) ciphertextB64 = obj.encrypted;
  } catch {
    /* raw base64 */
  }
  const dec = (s: string): Uint8Array => {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const o = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
    return o;
  };
  const raw = dec(ciphertextB64.replace(/\s+/g, ""));
  if (raw.length <= 12) throw new Error("doubao_new 加密密钥过短");
  const salt = new TextEncoder().encode("fixed-salt");
  const mat = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveKey"]);
  const aesKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    mat,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const nonce = raw.slice(0, 12);
  const data = raw.slice(12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, data));
  let jwk = JSON.parse(new TextDecoder().decode(plain));
  if (!jwk.d) jwk = jwk.privateKey || jwk.keyPair || jwk.jwk;
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

// ---------- 驱动 ----------
export class DoubaoNewDriver extends CloudBase {
  readonly id = "doubao_new";

  private cookie = "";
  private appId = "497858";
  private dpopSecret = "";
  private authClientId = "";
  private authClientType = "";
  private authScope = "";
  private authSdkSource = "";
  private authSdkVersion = "";
  private rootToken = "";
  private ignoreJwt = false;
  private shareLink = false;

  private authorization = ""; // access token（无 scheme）
  private staticDpop = ""; // 静态 DPoP（cookie 提供）
  private dpopKey: CryptoKey | null = null; // 用于签发 DPoP 证明

  private tokenCache = new Map<string, string>();

  private cfgStr(k: string): string {
    return ((this.cfg as Record<string, unknown>)[k] as string) || "";
  }
  private cfgBool(k: string): boolean {
    const v = (this.cfg as Record<string, unknown>)[k];
    return v === true || v === "true" || v === 1 || v === "1";
  }
  private authReady(): boolean {
    return !!(this.authClientId && this.authClientType && this.authScope && this.authSdkSource && this.authSdkVersion);
  }

  protected async hdrs(): Promise<Record<string, string>> {
    return this.cookie ? { Cookie: this.cookie } : {};
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.cookie = this.cfgStr("cookie");
    this.appId = this.cfgStr("app_id") || "497858";
    this.dpopSecret = this.cfgStr("dpop_key_secret");
    this.authClientId = this.cfgStr("auth_client_id");
    this.authClientType = this.cfgStr("auth_client_type");
    this.authScope = this.cfgStr("auth_scope");
    this.authSdkSource = this.cfgStr("auth_sdk_source");
    this.authSdkVersion = this.cfgStr("auth_sdk_version");
    this.rootToken = this.cfgStr("root_id");
    this.ignoreJwt = this.cfgBool("ignore_jwt_check");
    this.shareLink = this.cfgBool("share_link");

    const cached = await loadTokens(this.env.KV, this.mountId);
    if (cached?.access_token) this.authorization = cached.access_token;
    else {
      const t = getCookie(this.cookie, "LARK_SUITE_ACCESS_TOKEN");
      if (t) this.authorization = trimScheme(t);
    }
    this.staticDpop = getCookie(this.cookie, "LARK_SUITE_DPOP");
    const kp = getCookie(this.cookie, "feishu_dpop_keypair");
    if (kp && this.dpopSecret) {
      try {
        this.dpopKey = await importDpopKeyPair(kp, this.dpopSecret);
      } catch {
        this.dpopKey = null;
      }
    }
  }

  private resolveAuthorization(): string {
    const a = trimScheme(this.authorization);
    return a ? "DPoP " + a : "";
  }

  private async resolveDpop(method: string, url: string): Promise<string> {
    if (this.dpopKey) return genDpop(this.dpopKey, method, normalizeUrl(url));
    if (this.staticDpop) {
      if (!this.ignoreJwt) {
        const exp = jwtExp(this.staticDpop);
        if (exp > 0 && exp <= Math.floor(Date.now() / 1000) + 5) {
          return "";
        }
      }
      return this.staticDpop;
    }
    return "";
  }

  private async ensureAuth(): Promise<void> {
    if (!shouldRefresh(this.authorization)) return;
    if (!this.dpopKey || !this.cookie || !this.authReady()) return;
    try {
      const dpop = await genDpop(this.dpopKey, "POST", normalizeUrl(DOUBAO_URL + "/passport/user/biz_auth/"));
      const tok = await this.fetchBizAuth(dpop, false);
      this.authorization = trimScheme(tok);
      const ts: TokenSet = {
        access_token: this.authorization,
        expires_at: jwtExp(this.authorization) * 1000,
      };
      await saveTokens(this.env.KV, this.mountId, ts);
    } catch (e) {
      if (!this.authorization) throw e;
    }
  }

  private async fetchBizAuth(dpop: string, isPublic: boolean): Promise<string> {
    const url = new URL(DOUBAO_URL + (isPublic ? "/passport/anonymity_user/biz_auth/" : "/passport/user/biz_auth/"));
    url.searchParams.set("aid", this.appId);
    url.searchParams.set("account_sdk_source", this.authSdkSource);
    url.searchParams.set("sdk_version", this.authSdkVersion);
    const headers: Record<string, string> = {
      accept: "application/json, text/javascript",
      origin: DOUBAO_URL,
      referer: DOUBAO_URL + "/",
      "content-type": "application/x-www-form-urlencoded",
    };
    if (this.cookie) headers["Cookie"] = this.cookie;
    const csrf = getCookie(this.cookie, "passport_csrf_token");
    if (csrf) headers["x-tt-passport-csrf-token"] = csrf;
    const old = this.resolveAuthorization();
    if (old) headers["authorization"] = old;
    if (dpop) headers["dpop"] = dpop;
    const form = new URLSearchParams({
      client_id: this.authClientId,
      client_type: this.authClientType,
      scope: this.authScope,
      d_pop: dpop,
    });
    const res = await fetch(url.toString(), { method: "POST", headers, body: form.toString() });
    const j = (await res.json()) as any;
    if (j.message !== "success" || !j.data?.access_token) {
      throw new Error(`[doubao_new] biz_auth: ${j.message} ${j.data?.description || ""}`);
    }
    return j.data.access_token as string;
  }

  // 通用 API 请求（GET/POST），自动附加鉴权头并解析 {code,msg,message,data}
  private async api(method: string, path: string, opts: { query?: Record<string, string | string[]>; json?: any; form?: Record<string, string>; extraHeaders?: Record<string, string> } = {}): Promise<any> {
    await this.ensureAuth();
    const url = new URL(BASE_URL + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
        else url.searchParams.set(k, v);
      }
    }
    const headers: Record<string, string> = {
      accept: "*/*",
      origin: DOUBAO_URL,
      referer: DOUBAO_URL + "/",
      ...(opts.extraHeaders || {}),
    };
    if (this.cookie) headers["Cookie"] = this.cookie;
    const auth = this.resolveAuthorization();
    if (auth) headers["Authorization"] = auth;
    const dpop = await this.resolveDpop(method, url.toString());
    if (dpop) headers["Dpop"] = dpop;

    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.form).toString();
    }
    const res = await fetch(url.toString(), { method, headers, body });
    const text = await res.text();
    let j: any;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`doubao_new 响应解析失败 ${res.status}: ${text.slice(0, 200)}`);
    }
    if (j.code !== 0) throw new Error(`doubao_new API ${j.code}: ${j.msg || j.message}`);
    return j;
  }

  // 表单类写操作（带 csrf 重试）
  private async formPost(path: string, form: Record<string, string>, extraHeaders: Record<string, string> = {}): Promise<any> {
    await this.ensureAuth();
    const url = new URL(BASE_URL + path);
    const doReq = async (csrf: string): Promise<{ res: Response; text: string }> => {
      const headers: Record<string, string> = {
        accept: "*/*",
        origin: DOUBAO_URL,
        referer: DOUBAO_URL + "/",
        "content-type": "application/x-www-form-urlencoded",
        ...extraHeaders,
      };
      if (this.cookie) headers["Cookie"] = this.cookie;
      const auth = this.resolveAuthorization();
      if (auth) headers["Authorization"] = auth;
      const dpop = await this.resolveDpop("POST", url.toString());
      if (dpop) headers["Dpop"] = dpop;
      if (csrf) headers["x-csrftoken"] = csrf;
      const res = await fetch(url.toString(), { method: "POST", headers, body: new URLSearchParams(form).toString() });
      return { res, text: await res.text() };
    };
    const tryParse = (text: string): any => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    };
    let { res, text } = await doReq(getCookie(this.cookie, "_csrf_token"));
    let j = tryParse(text);
    if ((j && (j.code !== 0 || /csrf token error/i.test(text))) || res.status === 403) {
      const retry = await doReq(getCookie(this.cookie, "_csrf_token"));
      res = retry.res;
      text = retry.text;
      j = tryParse(text);
    }
    if (!j) throw new Error(`doubao_new 响应解析失败 ${res.status}: ${text.slice(0, 200)}`);
    if (j.code !== 0) throw new Error(`doubao_new API ${j.code}: ${j.msg || j.message}`);
    return j;
  }

  // ---------- 路径解析 ----------
  private packTok(nodeToken: string, objToken: string): string {
    return `${nodeToken}|${objToken}`;
  }
  private unpackTok(etag: string): { nodeToken: string; objToken: string } {
    const i = (etag || "").indexOf("|");
    if (i < 0) return { nodeToken: etag || "", objToken: "" };
    return { nodeToken: etag.slice(0, i), objToken: etag.slice(i + 1) };
  }

  private async listRaw(token: string): Promise<NodeT[]> {
    const query: Record<string, string | string[]> = {
      obj_type: OBJ_TYPES,
      length: "50",
      rank: "0",
      asc: "0",
      min_length: "40",
      thumbnail_width: "1028",
      thumbnail_height: "1028",
      thumbnail_policy: "4",
    };
    if (token) query.token = token;
    const j = await this.api("GET", "/space/api/explorer/doubao/children/list/", { query });
    const data = j.data || {};
    const map: Record<string, NodeT> = data.entities?.nodes || {};
    const nodes: NodeT[] = [];
    if (Array.isArray(data.node_list) && data.node_list.length) {
      for (const t of data.node_list) if (map[t]) nodes.push(map[t]);
    } else {
      for (const k of Object.keys(map)) nodes.push(map[k]);
    }
    return nodes;
  }

  private toItem(node: NodeT, dirPath: string): FileItem {
    const isDir = node.type === 0;
    return {
      name: node.name,
      path: joinPath(dirPath, node.name),
      is_dir: isDir,
      size: parseSize(node.extra?.size),
      modified: (Number(node.edit_time) || Number(node.create_time) || 0) * 1000,
      etag: this.packTok(node.node_token, node.obj_token),
    };
  }

  private async resolveToken(path: string): Promise<string> {
    const norm = normalizePath(path);
    if (norm === "/") return this.rootToken;
    if (this.tokenCache.has(norm)) return this.tokenCache.get(norm)!;
    const parts = norm.split("/").filter(Boolean);
    let cur = "/";
    let token = this.rootToken;
    for (const p of parts) {
      cur = joinPath(cur, p);
      if (this.tokenCache.has(cur)) {
        token = this.tokenCache.get(cur)!;
        continue;
      }
      const nodes = await this.listRaw(token);
      const it = nodes.find((n) => n.name === p);
      if (!it) throw new Error(`doubao_new 路径不存在: ${cur}`);
      token = it.node_token;
      this.tokenCache.set(cur, token);
    }
    return token;
  }

  // ---------- Driver 接口 ----------
  async list(path: string): Promise<FileItem[]> {
    const token = await this.resolveToken(path);
    const nodes = await this.listRaw(token);
    return nodes
      .filter((n) => n.node_token && n.obj_token)
      .map((n) => this.toItem(n, path));
  }

  async get(path: string): Promise<FileItem> {
    if (path === "/") return { name: "", path: "/", is_dir: true, size: 0, modified: 0 };
    const items = await this.list(parentPath(path));
    const it = items.find((i) => i.path === path);
    if (!it) throw new Error(`doubao_new 文件不存在: ${path}`);
    return it;
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const item = await this.get(path);
    if (item.is_dir) throw new Error("doubao_new 目录不可下载");
    await this.ensureAuth();
    const { objToken } = this.unpackTok(item.etag!);
    if (!objToken) throw new Error("doubao_new 缺少 obj_token");
    const auth = this.resolveAuthorization();
    const dpop = await this.resolveDpop("GET", `${DOWNLOAD_BASE_URL}/space/api/box/stream/download/all/${objToken}/`);
    const url = new URL(`${DOWNLOAD_BASE_URL}/space/api/box/stream/download/all/${objToken}/`);
    if (auth) url.searchParams.set("authorization", auth);
    if (dpop) url.searchParams.set("dpop", dpop);
    const headers: Record<string, string> = { Referer: DOUBAO_URL + "/", "User-Agent": UA };
    if (range) headers["Range"] = range;
    const res = await fetch(url.toString(), { headers });
    return res; // 流式代理（令牌不对外泄露）
  }

  async createUpload(_path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(_path)}`, method: "PUT", headers: { "x-driver": "doubao_new" } };
  }

  // ---------- 上传（prepare → blocks → merge → finish） ----------
  private async prepareUpload(name: string, size: number, mountNodeToken: string): Promise<any> {
    const query: Record<string, string> = {
      shouldBypassScsDialog: "true",
      doubao_storage: "imagex_other",
      doubao_app_id: this.appId,
    };
    const body: any = { mount_point: "explorer", mount_node_token: "", name, size, size_checker: true };
    if (mountNodeToken) body.mount_node_token = mountNodeToken;
    const j = await this.api("POST", "/space/api/box/upload/prepare/", {
      query,
      json: body,
      extraHeaders: {
        "x-command": "space.api.box.upload.prepare",
        "rpc-persist-doubao-pan": "true",
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
    });
    return j.data;
  }

  private async uploadBlocks(uploadId: string, blocks: any[]): Promise<any> {
    const query: Record<string, string> = {
      shouldBypassScsDialog: "true",
      doubao_storage: "imagex_other",
      doubao_app_id: this.appId,
    };
    const j = await this.api("POST", "/space/api/box/upload/blocks/", {
      query,
      json: { blocks, upload_id: uploadId, mount_point: "explorer" },
      extraHeaders: {
        "x-command": "space.api.box.upload.blocks",
        "rpc-persist-doubao-pan": "true",
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
    });
    return j.data;
  }

  private async mergeUploadBlocks(uploadId: string, seqs: number[], checksums: string[], sizes: number[], blockOriginSize: number, data: Uint8Array): Promise<any> {
    const url = new URL(`${DOWNLOAD_BASE_URL}/space/api/box/stream/upload/merge_block/`);
    url.searchParams.set("shouldBypassScsDialog", "true");
    url.searchParams.set("upload_id", uploadId);
    url.searchParams.set("mount_point", "explorer");
    url.searchParams.set("doubao_storage", "imagex_other");
    url.searchParams.set("doubao_app_id", this.appId);
    const headers: Record<string, string> = {
      accept: "application/json, text/plain, */*",
      origin: DOUBAO_URL,
      referer: DOUBAO_URL + "/",
      "rpc-persist-doubao-pan": "true",
      "content-type": "application/octet-stream",
      "x-block-list-checksum": checksums.join(","),
      "x-seq-list": seqs.join(","),
      "x-block-origin-size": String(blockOriginSize),
      "x-command": "space.api.box.stream.upload.merge_block",
      "x-csrftoken": "",
    };
    const auth = this.resolveAuthorization();
    if (auth) headers["Authorization"] = auth;
    const dpop = await this.resolveDpop("POST", url.toString());
    if (dpop) headers["Dpop"] = dpop;
    const reqId = Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    headers["x-request-id"] = reqId;
    const res = await fetch(url.toString(), { method: "POST", headers, body: data });
    const j = (await res.json()) as any;
    if (j.code !== 0) throw new Error(`doubao_new merge API ${j.code}: ${j.msg || j.message}`);
    return j.data;
  }

  private async uploadBlockV3(uploadId: string, block: { seq: number; size: number; checksum: string }, data: Uint8Array): Promise<void> {
    const url = new URL(`${DOWNLOAD_BASE_URL}/space/api/box/stream/upload/v3/block/`);
    url.searchParams.set("shouldBypassScsDialog", "true");
    url.searchParams.set("upload_id", uploadId);
    url.searchParams.set("seq", String(block.seq));
    url.searchParams.set("size", String(block.size));
    url.searchParams.set("checksum", block.checksum);
    url.searchParams.set("mount_point", "explorer");
    url.searchParams.set("doubao_storage", "imagex_other");
    url.searchParams.set("doubao_app_id", this.appId);
    const headers: Record<string, string> = {
      accept: "*/*",
      origin: DOUBAO_URL,
      referer: DOUBAO_URL + "/",
      "rpc-persist-doubao-pan": "true",
      "x-block-seq": String(block.seq),
      "x-block-checksum": block.checksum,
    };
    const auth = this.resolveAuthorization();
    if (auth) headers["Authorization"] = auth;
    const dpop = await this.resolveDpop("POST", url.toString());
    if (dpop) headers["Dpop"] = dpop;
    const fd = new FormData();
    fd.set("upload_id", uploadId);
    fd.set("size", String(data.length));
    fd.append("file", new Blob([data], { type: "application/octet-stream" }), "blob");
    const res = await fetch(url.toString(), { method: "POST", headers, body: fd });
    const text = await res.text();
    let j: any;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`doubao_new v3 响应解析失败 ${res.status}: ${text.slice(0, 200)}`);
    }
    if (j.code !== 0) throw new Error(`doubao_new v3 API ${j.code}: ${j.msg || j.message}`);
  }

  private async finishUpload(uploadId: string, numBlocks: number): Promise<any> {
    const query: Record<string, string> = {
      shouldBypassScsDialog: "true",
      doubao_storage: "imagex_other",
      doubao_app_id: this.appId,
    };
    const j = await this.api("POST", "/space/api/box/upload/finish/", {
      query,
      json: {
        upload_id: uploadId,
        num_blocks: numBlocks,
        mount_point: "explorer",
        push_open_history_record: 1,
      },
      extraHeaders: {
        "x-command": "space.api.box.upload.finish",
        "rpc-persist-doubao-pan": "true",
        "cache-control": "no-cache",
        pragma: "no-cache",
        "biz-scene": "file_upload",
        "biz-ua-type": "Web",
      },
    });
    return j.data;
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, size = 0): Promise<void> {
    const parentToken = await this.resolveToken(parentPath(path));
    const name = basename(path);
    const buf = new Uint8Array(await new Response(body).arrayBuffer());
    const totalSize = size || buf.length;
    if (totalSize <= 0) throw new Error("doubao_new 无效文件大小");

    const prep = await this.prepareUpload(name, totalSize, parentToken);
    const blockSize = prep.block_size > 0 ? Number(prep.block_size) : 8 * 1024 * 1024;
    const numBlocks = prep.num_blocks > 0 ? Number(prep.num_blocks) : Math.ceil(totalSize / blockSize) || 1;
    const uploadId = prep.upload_id;
    if (!uploadId) throw new Error("doubao_new 缺少 upload_id");

    const blocks: any[] = [];
    const blockData: Uint8Array[] = [];
    const blockMeta = new Map<number, any>();
    for (let seq = 0; seq < numBlocks; seq++) {
      const offset = seq * blockSize;
      let length = blockSize;
      if (totalSize - offset < length) length = totalSize - offset;
      const slice = buf.slice(offset, offset + length);
      const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", slice));
      const hash = b64std(sum);
      const checksum = String(adler32(slice));
      const b = { hash, seq, size: length, checksum, isUploaded: true };
      blocks.push(b);
      blockData[seq] = slice;
      blockMeta.set(seq, b);
    }

    const neededRaw = await this.uploadBlocks(uploadId, blocks);
    const needList: any[] =
      neededRaw?.needed_upload_blocks?.length > 0
        ? neededRaw.needed_upload_blocks
        : blocks.map((b) => ({ seq: b.seq, size: b.size, checksum: b.checksum, hash: b.hash }));

    const maxMerge = 20;
    const flush = async (seqs: number[], checksums: string[], sizes: number[], groupBuf: Uint8Array): Promise<void> => {
      const resp = await this.mergeUploadBlocks(uploadId, seqs, checksums, sizes, blockSize, groupBuf);
      const ok = resp?.success_seq_list || [];
      if (ok.length !== seqs.length) {
        for (let i = 0; i < seqs.length; i++) {
          await this.uploadBlockV3(uploadId, { seq: seqs[i], size: sizes[i], checksum: checksums[i] }, blockData[seqs[i]]);
        }
      }
    };

    let gSeqs: number[] = [];
    let gChecksums: string[] = [];
    let gSizes: number[] = [];
    let gBuf = new Uint8Array(0);
    for (const item of needList) {
      const seq = Number(item.seq);
      const meta = blockMeta.get(seq);
      if (!meta) continue;
      const piece = blockData[seq];
      if (String(adler32(piece)) !== item.checksum) {
        throw new Error(`doubao_new 分块校验失败 seq=${seq}`);
      }
      gSeqs.push(seq);
      gChecksums.push(item.checksum);
      gSizes.push(item.size);
      const nb = new Uint8Array(gBuf.length + piece.length);
      nb.set(gBuf);
      nb.set(piece, gBuf.length);
      gBuf = nb;
      if (gSeqs.length >= maxMerge) {
        await flush(gSeqs, gChecksums, gSizes, gBuf);
        gSeqs = [];
        gChecksums = [];
        gSizes = [];
        gBuf = new Uint8Array(0);
      }
    }
    if (gSeqs.length) await flush(gSeqs, gChecksums, gSizes, gBuf);

    await this.finishUpload(uploadId, numBlocks);
  }

  // ---------- 写操作 ----------
  async mkdir(path: string): Promise<void> {
    const parentToken = await this.resolveToken(parentPath(path));
    const name = basename(path);
    const form: Record<string, string> = { name, source: "0" };
    if (parentToken) form.parent_token = parentToken;
    const j = await this.formPost("/space/api/explorer/v2/create/folder/", form);
    const data = j.data || {};
    const map: Record<string, NodeT> = data.entities?.nodes || {};
    let node: NodeT | undefined;
    if (data.node_list?.length && map[data.node_list[0]]) node = map[data.node_list[0]];
    else node = Object.values(map)[0];
    if (!node) throw new Error("doubao_new 创建目录失败");
  }

  async remove(path: string): Promise<void> {
    const item = await this.get(path);
    const { nodeToken } = this.unpackTok(item.etag!);
    const j = await this.api("POST", "/space/api/explorer/v3/remove/", {
      json: { tokens: [nodeToken], apply: 1 },
      extraHeaders: { accept: "application/json, text/plain, */*" },
    });
    const taskId = j.data?.task_id;
    if (taskId) await this.waitTask(taskId);
  }

  async rename(from: string, to: string): Promise<void> {
    const item = await this.get(from);
    const { nodeToken, objToken } = this.unpackTok(item.etag!);
    if (item.is_dir) {
      await this.formPost("/space/api/explorer/v2/rename/", { token: nodeToken, name: basename(to) });
    } else {
      await this.api("POST", "/space/api/box/file/update_info/", {
        json: { file_token: objToken, name: basename(to) },
      });
    }
  }

  async move(from: string, to: string): Promise<void> {
    const item = await this.get(from);
    const { nodeToken } = this.unpackTok(item.etag!);
    const destToken = await this.resolveToken(parentPath(to));
    await this.formPost("/space/api/explorer/v2/move/", { src_token: nodeToken, dest_token: destToken });
  }

  private async waitTask(taskId: string): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt++) {
      const url = new URL(BASE_URL + "/space/api/explorer/v2/task/");
      url.searchParams.set("task_id", taskId);
      const headers: Record<string, string> = {
        accept: "application/json, text/plain, */*",
        origin: DOUBAO_URL,
        referer: DOUBAO_URL + "/",
      };
      const auth = this.resolveAuthorization();
      if (auth) headers["Authorization"] = auth;
      const dpop = await this.resolveDpop("GET", url.toString());
      if (dpop) headers["Dpop"] = dpop;
      const res = await fetch(url.toString(), { headers });
      const j = (await res.json()) as any;
      if (j.code !== 0) throw new Error(`doubao_new 任务查询 ${j.code}: ${j.msg || j.message}`);
      if (j.data?.is_fail) throw new Error(`doubao_new 任务失败: ${taskId}`);
      if (j.data?.is_finish) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`doubao_new 任务超时: ${taskId}`);
  }
}

