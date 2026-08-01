const TOKEN_KEY = "eol_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function req(path: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = { ...((opts.headers as any) || {}) };
  const token = getToken();
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 && !path.includes("/api/auth/login")) {
    clearToken();
    location.reload();
  }
  return res;
}

// 容错：后端偶发返回非 JSON（如瞬时 500）时，避免 res.json() 直接抛丑错误
async function errText(res: Response): Promise<string> {
  const t = await res.text();
  try {
    const j = JSON.parse(t);
    return (j && j.error) || t || `请求失败 (${res.status})`;
  } catch {
    return t || `请求失败 (${res.status})`;
  }
}

export interface FileItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
  etag?: string;
}

export const api = {
  async login(username: string, password: string) {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(await errText(res) || "登录失败");
    const data = await res.json();
    setToken(data.token);
    return data;
  },
  async listMounts() {
    try {
      const res = await req("/api/mounts");
      const j = await res.json();
      return (j && j.items) || [];
    } catch {
      return [];
    }
  },
  async listFiles(mount: number, path: string) {
    const res = await req(`/api/fs/list?mount=${mount}&path=${encodeURIComponent(path)}`);
    return (await res.json()).items as FileItem[];
  },
  async mkdir(mount: number, path: string) {
    await req("/api/fs/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mount, path }),
    });
  },
  async remove(mount: number, path: string) {
    await req("/api/fs/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mount, path }),
    });
  },
  async rename(mount: number, from: string, to: string) {
    await req("/api/fs/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mount, from, to }),
    });
  },
  async move(mount: number, from: string, to: string) {
    await req("/api/fs/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mount, from, to }),
    });
  },
  // 初始化上传，返回客户端直传凭证
  async uploadInit(mount: number, path: string, size: number) {
    const res = await req("/api/fs/upload/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mount, path, size }),
    });
    return (await res.json()) as { uploadUrl: string; method: string; headers: Record<string, string> };
  },
  async share(mount: number, path: string, password?: string, expire_hours?: number) {
    const res = await req("/api/fs/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mount, path, password, expire_hours }),
    });
    return (await res.json()) as { id: string; url: string };
  },
  async search(kw: string) {
    const res = await req(`/api/fs/search?kw=${encodeURIComponent(kw)}`);
    return (await res.json()).items as any[];
  },
  // 挂载管理
  async getDrivers() {
    const res = await req("/api/mounts/drivers");
    return (await res.json()) as { drivers: string[]; schemas: any[] };
  },
  async createMount(body: { name: string; driver: string; config: Record<string, unknown>; root?: string; order?: number }) {
    const res = await req("/api/mounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await errText(res) || "创建失败");
    return (await res.json()) as { id: number };
  },
  async updateMount(id: number, body: { name?: string; driver?: string; config?: Record<string, unknown>; root?: string; order?: number; enabled?: number }) {
    const res = await req(`/api/mounts/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await errText(res) || "更新失败");
    return res.json();
  },
  async deleteMount(id: number) {
    const res = await req(`/api/mounts/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await errText(res) || "删除失败");
    return res.json();
  },
  async oauthProviders() {
    const res = await req("/api/oauth/providers");
    return (await res.json()).providers as string[];
  },
  // 返回平台授权页 URL（前端在弹窗打开，完成后再回来）
  async oauthStartUrl(provider: string, mountId: number) {
    const res = await req(`/api/oauth/${provider}/start?mount=${mountId}`);
    const j = await res.json();
    return j.url as string;
  },
  downloadUrl(mount: number, path: string) {
    return `/api/fs/get?mount=${mount}&path=${encodeURIComponent(path)}`;
  },
  previewUrl(mount: number, path: string) {
    return `/api/fs/raw?mount=${mount}&path=${encodeURIComponent(path)}`;
  },
  async changePassword(old_password: string, new_password: string) {
    const res = await req("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_password, new_password }),
    });
    if (!res.ok) throw new Error(await errText(res) || "修改失败");
    return res.json();
  },
  async needsSetup(): Promise<boolean> {
    try {
      const res = await fetch("/api/auth/needs-setup");
      if (!res.ok) return false;
      const j = await res.json();
      return !!j.needed;
    } catch {
      return false;
    }
  },
  // 当前登录用户（刷新后恢复 user；401 返回 null 由调用方登出）
  async me(): Promise<{ id: number; username: string; role: string } | null> {
    const token = getToken();
    if (!token) return null;
    try {
      const res = await fetch("/api/auth/me", { headers: { Authorization: "Bearer " + token } });
      if (res.status === 401) { clearToken(); return null; }
      if (!res.ok) return null;
      const j = await res.json();
      return j.user as { id: number; username: string; role: string };
    } catch {
      return null;
    }
  },
};

// 直传文件：根据 upload/init 返回的凭证上传（R2/S3 预签名直传，WebDAV 经 Worker 代理）
export async function uploadFile(target: { uploadUrl: string; method: string; headers: Record<string, string> }, file: File) {
  const headers: Record<string, string> = { ...target.headers };
  if (!headers["Content-Type"] && file.type) headers["Content-Type"] = file.type;
  // 同源请求（WebDAV 代理上传）需带上鉴权；外部预签名 URL 不加
  const isSameOrigin = target.uploadUrl.startsWith("/") || target.uploadUrl.startsWith(location.origin);
  if (isSameOrigin) {
    const token = getToken();
    if (token) headers["Authorization"] = "Bearer " + token;
  }
  await fetch(target.uploadUrl, { method: target.method || "PUT", headers, body: file });
}
