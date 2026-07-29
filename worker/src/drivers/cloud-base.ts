import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../types";

// 所有云端驱动（OAuth 网盘 / 国内网盘）的公共基类：
// - 通过 cfg._mountId 在 KV 索引令牌
// - 提供 JSON GET/POST 与原始请求辅助（自动附加鉴权头）
// 子类只需实现 hdrs()（Bearer / Cookie）与各 Driver 方法。
export abstract class CloudBase implements Driver {
  readonly id: string = "base";
  protected env!: Env;
  protected cfg!: DriverConfig;

  protected get mountId(): number {
    return Number((this.cfg as Record<string, unknown>)._mountId);
  }

  use(env: Env): void {
    this.env = env;
  }
  async init(cfg: DriverConfig): Promise<void> {
    this.cfg = cfg;
  }

  // 鉴权头（子类实现：Bearer 或 Cookie）
  protected abstract hdrs(): Promise<Record<string, string>>;

  protected async jsonGet<T>(url: string, extra: Record<string, string> = {}): Promise<T> {
    const r = await fetch(url, { headers: { ...(await this.hdrs()), ...extra } });
    if (!r.ok) throw new Error(`GET ${r.status} ${url}: ${await r.text().catch(() => "")}`);
    return (await r.json()) as T;
  }

  protected async jsonPost<T>(url: string, body: unknown, extra: Record<string, string> = {}): Promise<T> {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await this.hdrs()), ...extra },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST ${r.status} ${url}: ${await r.text().catch(() => "")}`);
    return (await r.json()) as T;
  }

  protected async req(url: string, method: string, body?: BodyInit | null, extra: Record<string, string> = {}): Promise<Response> {
    const r = await fetch(url, { method, headers: { ...(await this.hdrs()), ...extra }, body });
    if (!r.ok && r.status !== 206) throw new Error(`REQ ${method} ${r.status} ${url}`);
    return r;
  }

  abstract list(path: string): Promise<FileItem[]>;
  abstract get(path: string): Promise<FileItem>;
  abstract getContent(path: string, range?: string): Promise<Response | string>;
  abstract createUpload(path: string, size: number): Promise<UploadSession>;
  abstract mkdir(path: string): Promise<void>;
  abstract remove(path: string): Promise<void>;
  abstract rename(from: string, to: string): Promise<void>;
  abstract move(from: string, to: string): Promise<void>;
}
