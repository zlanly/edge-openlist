// 全局环境绑定（D1 / KV / R2 / Assets）
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  ASSETS: Fetcher;
  JWT_SECRET: string;
  /** 首次初始化管理员所需的一次性部署密钥。未配置时禁止自动建号。 */
  BOOTSTRAP_SECRET?: string;
  APP_TITLE: string;
  // 可选：自建 S3 网关等全局配置可在此扩展
}

// 统一文件项
export interface FileItem {
  name: string;
  path: string;       // 挂载内相对路径，以 / 开头
  is_dir: boolean;
  size: number;
  modified: number;   // 毫秒时间戳
  etag?: string;
}

// 驱动配置（从 mounts.config_json 解析）
export interface DriverConfig {
  [key: string]: unknown;
}

// 上传会话：客户端据此直传，绕过 Worker 请求体限制
export interface UploadSession {
  uploadUrl: string;
  method?: string;            // 默认 PUT
  headers?: Record<string, string>;
  // R2 预签名走 multipart/form-data 时，以下可选
  formFields?: Record<string, string>;
}

// 存储驱动统一接口
export interface Driver {
  readonly id: string;
  // 注入运行环境（R2/KV/fetch 等），在 init 之前调用
  use(env: Env): void;
  init(cfg: DriverConfig): Promise<void>;
  list(path: string): Promise<FileItem[]>;
  get(path: string): Promise<FileItem>;
  // 返回可直接流式转发的 Response，或上游直链字符串
  getContent(path: string, range?: string): Promise<Response | string>;
  // 返回客户端直传凭证
  createUpload(path: string, size: number): Promise<UploadSession>;
  // 上传完成后的落盘确认（部分后端需要）
  completeUpload?(path: string, session: UploadSession): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  // WebDAV 等无法给客户端预签名的后端，由 Worker 流式代理上传
  putContent?(path: string, body: ReadableStream, contentType?: string, size?: number): Promise<void>;
  search?(kw: string): Promise<FileItem[]>;
}

// 挂载记录
export interface MountRow {
  id: number;
  name: string;
  driver: string;
  config_json: string;
  root: string;
  order: number;
  enabled: number;
  created_at: number;
}

// 当前登录用户（挂在 context 上）
export interface AuthUser {
  id: number;
  username: string;
  role: string;
}

// Hono 应用环境（Bindings=CF 绑定，Variables=请求上下文）
import type { Context } from "hono";
export type AppEnv = {
  Bindings: Env;
  Variables: { user?: AuthUser };
};
export type AppContext = Context<AppEnv>;
