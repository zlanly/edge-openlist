// 统一错误模型。
//
// 设计要点（直接对应线上「无响应 / 莫名退回登录页」的根因）：
//  1. 只有「本站会话真的失效」才允许返回 401 且 code = "unauthenticated"。
//     上游网盘的 401/403 一律折叠为 502 upstream_error —— 否则前端会把
//     「网盘 Cookie 过期」误判成「你没登录」，进而清 token 把用户踢回登录页。
//  2. 任何未捕获异常都要经 app.onError 变成结构化 JSON，绝不能落到 Hono 默认的
//     500 text/plain "Internal Server Error"（前端 res.json() 会直接抛 SyntaxError）。

export type ErrorCode =
  | "bad_request"
  | "unauthenticated" // 唯一允许前端登出的信号
  | "bad_credentials" // 登录接口的「账号密码错误」，前端不得据此清 token
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unsupported"
  | "upstream_error" // 上游网盘/驱动出错，与本站登录态无关
  | "rate_limited"
  | "internal";

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly detail?: string;

  constructor(status: number, message: string, code: ErrorCode = "internal", detail?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  toJSON() {
    return this.detail ? { error: this.message, code: this.code, detail: this.detail } : { error: this.message, code: this.code };
  }
}

export const badRequest = (msg: string, detail?: string) => new HttpError(400, msg, "bad_request", detail);
export const unauthenticated = (msg = "登录已失效，请重新登录") => new HttpError(401, msg, "unauthenticated");
/** 登录失败。刻意与 unauthenticated 区分：它发生在登录页，前端不该「再登出一次」。 */
export const badCredentials = (msg = "用户名或密码错误") => new HttpError(401, msg, "bad_credentials");
export const forbidden = (msg = "没有权限执行此操作") => new HttpError(403, msg, "forbidden");
export const notFound = (msg = "资源不存在") => new HttpError(404, msg, "not_found");
export const unsupported = (msg: string) => new HttpError(400, msg, "unsupported");
export const rateLimited = (msg: string) => new HttpError(429, msg, "rate_limited");

/** 上游网盘错误。刻意用 502 而非透传上游状态码，避免污染本站鉴权语义。 */
export const upstreamError = (msg: string, detail?: string) => new HttpError(502, msg, "upstream_error", detail);

/** 把任意 throw 出来的东西规整成 HttpError。驱动抛的裸 Error 一律视为上游故障。 */
export function toHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return upstreamError(msg || "上游服务异常");
}

/**
 * 包裹驱动调用：把驱动抛的错统一转成 502，并带上挂载名便于用户自查。
 * 这样「terabox Cookie 失效」显示为一条明确的提示，而不是一个裸 500。
 */
export async function withDriver<T>(mountName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw upstreamError(`「${mountName}」访问失败：${msg}`, msg);
  }
}

/** 解析并校验整数查询参数；非法时返回 400 而不是让 NaN 流进 D1。 */
export function intParam(raw: string | undefined | null, name: string): number {
  if (raw === undefined || raw === null || raw === "") throw badRequest(`缺少参数 ${name}`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw badRequest(`参数 ${name} 非法：${raw}`);
  return n;
}
