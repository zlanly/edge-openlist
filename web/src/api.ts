// ---------------------------------------------------------------------------
// API 层
//
// 这一层过去是「莫名退回登录页」和「点了没反应」的前端根因所在：
//   · req() 对**任何** 401 都 clearToken() + location.reload()。上游网盘 Cookie 过期、
//     分享需要密码、甚至一次网络抖动，都会把用户踹回登录页并丢掉当前目录。
//   · 写操作（mkdir/remove/rename/move）压根不看响应，失败了界面照样刷新，
//     用户以为成功了，其实什么都没发生。
//   · 没有超时，Worker 一旦卡住，前端就永远转圈。
//   · downloadUrl/previewUrl 不带任何凭据，window.open 必然 401。
//
// 现在：统一 ApiError（带 code）、只认 code==="unauthenticated" 才登出、
// 全量超时 + 幂等重试、内容令牌签名 URL、上传带真实进度与取消。
// ---------------------------------------------------------------------------

const TOKEN_KEY = "eol_token";
const DEFAULT_TIMEOUT = 30_000;

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // 隐私模式下 localStorage 可能直接抛错
  }
}
export function setToken(t: string) {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {}
}
export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

// ---------- 错误模型 ----------
export type ApiCode =
  | "bad_request"
  | "unauthenticated"
  | "bad_credentials"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unsupported"
  | "upstream_error"
  | "rate_limited"
  | "internal"
  | "network"
  | "timeout"
  | "need_password";

export class ApiError extends Error {
  status: number;
  code: ApiCode;
  detail?: string;
  constructor(message: string, status: number, code: ApiCode, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
  /** 只有这一种情况才该把用户送回登录页。 */
  get isSessionExpired(): boolean {
    return this.code === "unauthenticated";
  }
  /** 网络/超时/上游故障 —— 值得给用户一个「重试」按钮。 */
  get isRetryable(): boolean {
    return this.code === "network" || this.code === "timeout" || this.code === "upstream_error" || this.status >= 500;
  }
}

// ---------- 会话失效广播 ----------
// 不再用 location.reload()：整页刷新会丢掉当前目录、滚动位置和未完成的上传。
// 改为发事件，由 App 决定如何优雅降级（弹提示 + 回到登录视图）。
type SessionListener = () => void;
const sessionListeners = new Set<SessionListener>();
export function onSessionExpired(fn: SessionListener): () => void {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}
function emitSessionExpired() {
  clearToken();
  for (const fn of sessionListeners) {
    try {
      fn();
    } catch {}
  }
}

// ---------- 核心请求 ----------
interface ReqOptions extends RequestInit {
  timeout?: number;
  /** 幂等请求失败时自动重试的次数（仅网络错误 / 5xx）。 */
  retries?: number;
  /** 跳过全局会话失效处理（登录、分享页等场景需要自己处理 401）。 */
  skipAuthRedirect?: boolean;
}

async function parseBody(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // 后端已保证 /api/* 一律 JSON；走到这里通常是 Cloudflare 的错误页
    return { error: text.slice(0, 300) };
  }
}

async function rawRequest(path: string, opts: ReqOptions = {}): Promise<Response> {
  const { timeout = DEFAULT_TIMEOUT, ...init } = opts;
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) || {}) };
  const token = getToken();
  if (token) headers["Authorization"] = "Bearer " + token;
  headers["Accept"] = headers["Accept"] || "application/json";

  // 超时：没有它，Worker 冷启动卡住或上游吊死时前端会无限转圈
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const external = init.signal;
  if (external) {
    if (external.aborted) ctl.abort();
    else external.addEventListener("abort", () => ctl.abort(), { once: true });
  }

  try {
    return await fetch(path, { ...init, headers, signal: ctl.signal });
  } catch (e: any) {
    if (ctl.signal.aborted && !external?.aborted) {
      throw new ApiError("请求超时，请检查网络后重试", 0, "timeout");
    }
    if (external?.aborted) throw new ApiError("请求已取消", 0, "network");
    throw new ApiError("网络连接失败，请检查网络后重试", 0, "network", e?.message);
  } finally {
    clearTimeout(timer);
  }
}

async function request<T = any>(path: string, opts: ReqOptions = {}): Promise<T> {
  const retries = opts.retries ?? (isIdempotent(opts.method) ? 1 : 0);
  let lastErr: ApiError | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await rawRequest(path, opts);
    } catch (e) {
      lastErr = e as ApiError;
      if (attempt < retries && lastErr.code === "network") {
        await sleep(300 * (attempt + 1));
        continue;
      }
      throw lastErr;
    }

    if (res.ok) {
      const body = await parseBody(res);
      return body as T;
    }

    const body = await parseBody(res);
    const code: ApiCode = body?.code || guessCode(res.status);
    const message = body?.error || defaultMessage(res.status);
    const err = new ApiError(message, res.status, code, body?.detail);

    // 5xx / 502 上游抖动值得重试一次；4xx 是确定性错误，重试没意义
    if (attempt < retries && res.status >= 500) {
      lastErr = err;
      await sleep(300 * (attempt + 1));
      continue;
    }

    // 关键分支：只有确凿的会话失效才登出。
    // 上游网盘的 401/403 在后端已被折叠成 502 upstream_error，不会走到这里。
    if (err.isSessionExpired && !opts.skipAuthRedirect) {
      emitSessionExpired();
    }
    throw err;
  }

  throw lastErr ?? new ApiError("请求失败", 0, "internal");
}

function isIdempotent(method?: string): boolean {
  const m = (method || "GET").toUpperCase();
  return m === "GET" || m === "HEAD";
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function guessCode(status: number): ApiCode {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 503 || status === 504) return "upstream_error";
  return "internal";
}
function defaultMessage(status: number): string {
  if (status === 404) return "资源不存在";
  if (status === 429) return "操作太频繁，请稍后再试";
  if (status >= 500) return "服务暂时不可用，请稍后重试";
  return `请求失败（${status}）`;
}

function jsonBody(data: unknown): ReqOptions {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
}

// ---------- 类型 ----------
export interface FileItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
  etag?: string;
}
export interface MountRow {
  id: number;
  name: string;
  driver: string;
  config_json: string;
  root: string;
  order: number;
  enabled: number;
}
export interface UserInfo {
  id: number;
  username: string;
  role: string;
}
export interface SignedUrls {
  token: string;
  download: string;
  preview: string;
}

// ---------- API ----------
export const api = {
  async login(username: string, password: string) {
    // skipAuthRedirect：登录失败的 401 绝不能触发「会话失效」流程
    const data = await request<{ token: string; user: UserInfo }>("/api/auth/login", {
      ...jsonBody({ username, password }),
      skipAuthRedirect: true,
    });
    setToken(data.token);
    return data;
  },

  async me(): Promise<UserInfo | null> {
    if (!getToken()) return null;
    try {
      const j = await request<{ user: UserInfo }>("/api/auth/me", { skipAuthRedirect: true, retries: 1 });
      return j.user;
    } catch (e) {
      // 只有确凿的「令牌无效」才算未登录。
      // 原实现把网络抖动、超时、500 全都当成「登录失效」直接登出 ——
      // 这正是用户抱怨「刷新一下就被踢出去」的原因。
      if (e instanceof ApiError && e.isSessionExpired) {
        clearToken();
        return null;
      }
      throw e;
    }
  },

  async needsSetup(): Promise<boolean> {
    try {
      const j = await request<{ needed: boolean }>("/api/auth/needs-setup", { skipAuthRedirect: true });
      return !!j?.needed;
    } catch {
      return false;
    }
  },

  // 初始化页状态：是否还需要初始化 + 是否配置了初始化密钥 + 异常原因（如未绑定数据库）
  async setupStatus(): Promise<{ needed: boolean; secretRequired: boolean; reason?: string }> {
    const j = await request<{ needed: boolean; secretRequired?: boolean; reason?: string }>("/api/auth/needs-setup", { skipAuthRedirect: true });
    return { needed: !!j?.needed, secretRequired: !!j?.secretRequired, reason: j?.reason };
  },

  // 初始化管理员账号（仅系统尚无任何用户时后端才会接受）
  setupAdmin(username: string, password: string, bootstrapSecret: string) {
    return request<{ ok: boolean }>("/api/auth/setup", {
      ...jsonBody({ username, password, bootstrapSecret }),
      skipAuthRedirect: true,
    });
  },

  changePassword(old_password: string, new_password: string) {
    return request("/api/auth/change-password", jsonBody({ old_password, new_password }));
  },

  // ---- 挂载 ----
  async listMounts(): Promise<MountRow[]> {
    // 原实现 try/catch 吞掉一切异常返回 []，于是后端 500 时界面显示
    // 「还没有挂载任何网盘」，引导用户去重新添加已经存在的挂载。现在如实抛错。
    const j = await request<{ items: MountRow[] }>("/api/mounts");
    return Array.isArray(j?.items) ? j.items : [];
  },
  async getDrivers() {
    return request<{ drivers: string[]; schemas: any[] }>("/api/mounts/drivers");
  },
  createMount(body: { name: string; driver: string; config: Record<string, unknown>; root?: string; order?: number }) {
    return request<{ id: number }>("/api/mounts", jsonBody(body));
  },
  updateMount(id: number, body: Record<string, unknown>) {
    return request(`/api/mounts/${id}`, { ...jsonBody(body), method: "PUT" });
  },
  deleteMount(id: number) {
    return request(`/api/mounts/${id}`, { method: "DELETE" });
  },

  // ---- 文件 ----
  async listFiles(mount: number, path: string, signal?: AbortSignal): Promise<FileItem[]> {
    const j = await request<{ items: FileItem[] }>(
      `/api/fs/list?mount=${mount}&path=${encodeURIComponent(path)}`,
      { signal, retries: 1 }
    );
    return Array.isArray(j?.items) ? j.items : [];
  },
  mkdir(mount: number, path: string) {
    return request("/api/fs/mkdir", jsonBody({ mount, path }));
  },
  remove(mount: number, path: string) {
    return request("/api/fs/remove", jsonBody({ mount, path }));
  },
  rename(mount: number, from: string, to: string) {
    return request("/api/fs/rename", jsonBody({ mount, from, to }));
  },
  move(mount: number, from: string, to: string) {
    return request("/api/fs/move", jsonBody({ mount, from, to }));
  },
  share(mount: number, path: string, password?: string, expire_hours?: number) {
    return request<{ id: string; url: string }>("/api/fs/link", jsonBody({ mount, path, password, expire_hours }));
  },
  async search(kw: string, signal?: AbortSignal): Promise<any[]> {
    const j = await request<{ items: any[] }>(`/api/fs/search?kw=${encodeURIComponent(kw)}`, { signal });
    return Array.isArray(j?.items) ? j.items : [];
  },

  /**
   * 取内容访问令牌。
   * 浏览器新标签页 / <video src> / <img src> 都无法携带 Authorization 头，
   * 所以下载与预览必须走这种「URL 自带短期凭据」的形式。
   */
  signUrls(mount: number, path: string) {
    return request<SignedUrls>(`/api/fs/sign?mount=${mount}&path=${encodeURIComponent(path)}`);
  },

  uploadInit(mount: number, path: string, size: number) {
    return request<{ uploadUrl: string; method: string; headers: Record<string, string> }>(
      "/api/fs/upload/init",
      jsonBody({ mount, path, size })
    );
  },

  // ---- OAuth ----
  async oauthProviders(): Promise<string[]> {
    try {
      const j = await request<{ providers: string[] }>("/api/oauth/providers");
      return Array.isArray(j?.providers) ? j.providers : [];
    } catch {
      return [];
    }
  },
  async oauthStartUrl(provider: string, mountId: number): Promise<string> {
    const j = await request<{ url: string }>(`/api/oauth/${provider}/start?mount=${mountId}`);
    return j.url;
  },
};

// ---------- 上传（带进度 + 可取消） ----------
// 原实现用 fetch 且不看响应：上传失败无人知晓，界面永远停在「上传中」。
// 改用 XHR 以拿到 upload.onprogress（fetch 至今没有可靠的上传进度）。
export interface UploadHandle {
  promise: Promise<void>;
  abort: () => void;
}

export function uploadFile(
  target: { uploadUrl: string; method: string; headers: Record<string, string> },
  file: File,
  onProgress?: (loaded: number, total: number) => void
): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<void>((resolve, reject) => {
    xhr.open(target.method || "PUT", target.uploadUrl, true);

    const headers: Record<string, string> = { ...target.headers };
    if (!headers["Content-Type"] && file.type) headers["Content-Type"] = file.type;
    // 同源（WebDAV 代理上传）才带本站凭据；外部预签名 URL 带了反而会被拒
    const sameOrigin = target.uploadUrl.startsWith("/") || target.uploadUrl.startsWith(location.origin);
    if (sameOrigin) {
      const token = getToken();
      if (token) headers["Authorization"] = "Bearer " + token;
    }
    for (const [k, v] of Object.entries(headers)) {
      try {
        xhr.setRequestHeader(k, v);
      } catch {}
    }

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(file.size, file.size);
        resolve();
        return;
      }
      // 关键：过去这里没有任何检查，失败也当成功
      let msg = `上传失败（${xhr.status}）`;
      let code: ApiCode = guessCode(xhr.status);
      try {
        const j = JSON.parse(xhr.responseText);
        if (j?.error) msg = j.error;
        if (j?.code) code = j.code;
      } catch {}
      reject(new ApiError(msg, xhr.status, code));
    };
    xhr.onerror = () => reject(new ApiError("上传中断，请检查网络", 0, "network"));
    xhr.ontimeout = () => reject(new ApiError("上传超时", 0, "timeout"));
    xhr.onabort = () => reject(new ApiError("上传已取消", 0, "network"));
    xhr.send(file);
  });

  return { promise, abort: () => xhr.abort() };
}
