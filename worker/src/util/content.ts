import { notFound, rateLimited, upstreamError } from "./errors";
import { isUselessContentType, mimeByExt } from "./mime";

// 内容分发的公共实现。fs / share / dav 三条路径过去各写了一份，
// 于是「不可变头」这个 bug 也被复制了三份。这里统一收口。

/** 不应转发给客户端的上游头：逐跳头 + 会串味的鉴权/编码头。 */
const DROP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-encoding", // Workers 已解压；透传会让浏览器二次解码报错
  "content-disposition", // 由我们按真实文件名重写
  "set-cookie", // 绝不能把网盘 Cookie 漏给浏览器
  "www-authenticate", // 否则浏览器会弹出上游的 Basic Auth 对话框
]);

/** Content-Disposition 的 filename 参数只能是 ASCII，非 ASCII 字符降级为下划线。 */
function asciiFallback(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download";
}

/**
 * 组装可返回的内容响应。
 *
 * 核心修复：fetch() 得到的 Response.headers 在 Workers 运行时是**不可变**的，
 * 原实现直接 `res.headers.set("Content-Disposition", ...)` 会抛
 * `TypeError: Can't modify immutable headers`，被 Hono 兜成 500 ——
 * 结果是「带 Range 的视频拖动进度条 / 断点续传」100% 失败。
 * 正确姿势：复制成一份可变 Headers 后重新构造 Response。
 */
export function buildContentResponse(upstream: Response, name: string, inline: boolean): Response {
  const headers = new Headers();
  const hadEncoding = !!upstream.headers.get("content-encoding");
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (DROP_HEADERS.has(k)) return;
    // 上游若做了压缩，其 content-length 是压缩后的长度，解压后必然对不上
    if (hadEncoding && k === "content-length") return;
    headers.set(key, value);
  });

  headers.set(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`
  );
  // 上游直链常不给类型（或给 application/octet-stream），而下面又强制 nosniff，
  // 两者叠加浏览器就拒绝渲染 —— 按扩展名补上真实类型（PDF 预览失效的根因）。
  if (isUselessContentType(headers.get("Content-Type"))) {
    const guess = mimeByExt(name);
    if (guess) headers.set("Content-Type", guess);
  }
  if (!headers.has("Accept-Ranges")) headers.set("Accept-Ranges", "bytes");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "private, max-age=0");
  // 预览任意文件时防止把 HTML/SVG 当页面执行（存储型 XSS）
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

/**
 * 上游状态码映射。
 * 绝不把上游的 401/403 透传成本站的 401 —— 那正是「莫名退回登录页」的元凶：
 * 网盘 Cookie 过期 → 上游 403 → 透传 403/401 → 前端以为本站登录失效 → 清 token 跳登录页。
 */
export function assertUpstreamOk(upstream: Response, mountName: string): void {
  const s = upstream.status;
  if (s < 400) return;
  if (s === 404 || s === 410) throw notFound("文件不存在或已被删除");
  if (s === 429) throw rateLimited(`「${mountName}」被上游限流，请稍后再试`);
  if (s === 401 || s === 403) {
    throw upstreamError(`「${mountName}」的登录凭据已失效，请到管理后台重新配置该挂载`, `upstream ${s}`);
  }
  throw upstreamError(`「${mountName}」返回异常状态 ${s}`, `upstream ${s}`);
}

/** 代理上游直链，附带 Range 透传与错误映射。 */
export async function proxyDirectLink(
  url: string,
  mountName: string,
  name: string,
  inline: boolean,
  range?: string
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(url, { headers: range ? { Range: range } : {}, redirect: "follow" });
  } catch (e) {
    throw upstreamError(`「${mountName}」直链请求失败：${e instanceof Error ? e.message : String(e)}`);
  }
  assertUpstreamOk(upstream, mountName);
  return buildContentResponse(upstream, name, inline);
}
