import { Hono } from "hono";
import type { AppEnv, AppContext, MountRow } from "../types";
import { authMiddleware } from "../middleware/auth";
import { getStore } from "../db/store";
import { normalizePath, sortItems, basename } from "../drivers";
import { buildDriver } from "../drivers/factory";
import { createContentToken, verifyContentToken } from "../util/auth";
import { badRequest, intParam, notFound, unauthenticated, unsupported, withDriver } from "../util/errors";
import { assertUpstreamOk, buildContentResponse, proxyDirectLink } from "../util/content";

const fs = new Hono<AppEnv>();

// 内容路由（/get、/raw）允许用「内容令牌」鉴权：浏览器导航、<video src>、
// 外部下载器都无法携带 Authorization 头，这是过去「点下载必 401、
// 然后前端把 401 当登录失效直接踢回登录页」的根因。
fs.use("*", async (c, next) => {
  const p = c.req.path;
  const isContentRoute = p.endsWith("/get") || p.endsWith("/raw");
  if (isContentRoute && c.req.query("token")) return next();
  return authMiddleware(c, next);
});

async function loadDriver(c: AppContext, mount: MountRow) {
  return withDriver(mount.name, () => buildDriver(c.env, mount));
}

/** 取挂载，不存在/被禁用一律 404（带 code，前端不会误判为登录失效）。 */
async function requireMount(c: AppContext, mountId: number, mustEnabled = true): Promise<MountRow> {
  const mount = await getStore(c.env).getMount(mountId);
  if (!mount) throw notFound("挂载不存在，可能已被删除");
  if (mustEnabled && !mount.enabled) throw notFound("该挂载已被禁用");
  return mount;
}

/** 解析 path（相对挂载根），并拦截 ../ 越权。 */
function resolvePath(mount: MountRow, p: string): string {
  const root = normalizePath(mount.root || "/");
  const rel = normalizePath(p || "/");
  // normalizePath 已折叠 ..，这里再兜一道，杜绝穿越到挂载根之外
  if (rel.includes("..")) throw badRequest("路径非法");
  if (root === "/") return rel;
  return normalizePath(root + rel);
}

/** 校验 path 参数：必须以 / 开头且长度可控。 */
function pathParam(raw: string | undefined | null, fallback = "/"): string {
  const p = raw ?? fallback;
  if (typeof p !== "string") throw badRequest("参数 path 非法");
  if (p.length > 2048) throw badRequest("路径过长");
  return p || fallback;
}

/**
 * 写操作专用：path 必须由调用方显式给出，绝不允许回退到 "/"。
 *
 * 原实现全都走 pathParam()，参数缺失时静默回退挂载根。于是客户端少传一个字段
 * （旧前端 rename 就发的 {path,name} 而不是 {from,to}），后端会心平气和地对
 * 挂载根执行 DELETE / MOVE —— 一次手滑就是整盘数据蒸发。这里改成硬失败。
 */
function requiredPathParam(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.trim() === "") throw badRequest(`缺少参数 ${field}`);
  if (raw.length > 2048) throw badRequest("路径过长");
  return raw;
}

/** 写操作兜底：目标不得是挂载根本身。 */
function assertNotMountRoot(mount: MountRow, target: string, action: string): string {
  if (target === "/" || target === normalizePath(mount.root || "/")) {
    throw badRequest(`不能${action}挂载根目录`);
  }
  return target;
}

// ---------- 列目录 ----------
fs.get("/list", async (c) => {
  const store = getStore(c.env);
  const mountId = intParam(c.req.query("mount"), "mount");
  const p = pathParam(c.req.query("path"));
  const mount = await requireMount(c, mountId);
  const driver = await loadDriver(c, mount);
  const full = resolvePath(mount, p);
  const items = sortItems(await withDriver(mount.name, () => driver.list(full)));

  // 索引写入做新鲜度节流：同一目录 10 分钟内只写一次。
  // 原实现每次浏览目录都全量重写 file_cache，一个 200 文件的目录 = 200 次 D1 写，
  // 免费档每日 10 万写配额随便逛几十次就爆 —— 配额耗尽后所有写操作报错，
  // 表现就是「用着用着突然全站无响应」。
  c.executionCtx?.waitUntil?.(
    (async () => {
      try {
        if (await store.isCacheFresh(mount.id, full)) return;
        await store.upsertFileCache(mount.id, items, full);
      } catch (e) {
        console.error("upsertFileCache failed", e);
      }
    })()
  );

  return c.json({ items, path: p, mount: { id: mount.id, name: mount.name } });
});

// ---------- 签发内容令牌 ----------
// 前端拿到 url 后可直接 window.open / 塞进 <video src>，无需 Authorization 头。
fs.get("/sign", async (c) => {
  const mountId = intParam(c.req.query("mount"), "mount");
  const p = pathParam(c.req.query("path"));
  const mount = await requireMount(c, mountId);
  const token = await createContentToken(c.env, { mount: mount.id, path: p });
  const q = `mount=${mount.id}&path=${encodeURIComponent(p)}&token=${encodeURIComponent(token)}`;
  return c.json({
    token,
    download: `/api/fs/get?${q}`,
    preview: `/api/fs/raw?${q}`,
  });
});

// ---------- 下载 / 预览 ----------

async function serveContent(c: AppContext, inline: boolean): Promise<Response> {
  const mountId = intParam(c.req.query("mount"), "mount");
  const p = pathParam(c.req.query("path"));

  // 内容令牌路径：校验签名且作用域必须与请求参数完全一致
  const token = c.req.query("token");
  if (token) {
    const claim = await verifyContentToken(c.env, token);
    if (!claim) throw unauthenticated("下载链接已过期，请回到文件列表重新获取");
    if (claim.mount !== mountId || claim.path !== p) {
      throw unauthenticated("下载链接与请求不匹配");
    }
  }

  const mount = await requireMount(c, mountId);
  const driver = await loadDriver(c, mount);
  const range = c.req.header("Range") || undefined;
  const full = resolvePath(mount, p);
  const res = await withDriver(mount.name, () => driver.getContent(full, range));

  const name = basename(p) || "download";

  if (typeof res === "string") {
    // 驱动给的是上游直链：由 Worker 代理转发（隐藏真实直链 + 统一鉴权）
    return proxyDirectLink(res, mount.name, name, inline, range);
  }

  assertUpstreamOk(res, mount.name);
  return buildContentResponse(res, name, inline);
}

fs.get("/get", (c) => serveContent(c, false));
fs.get("/raw", (c) => serveContent(c, true));

// ---------- 文件管理 ----------

/** 统一解析写操作的 JSON body，避免 body 非法时抛出裸 SyntaxError -> 500。 */
async function readJson<T>(c: AppContext): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
}

fs.post("/mkdir", async (c) => {
  const { mount: mountId, path } = await readJson<{ mount: number; path: string }>(c);
  const mount = await requireMount(c, intParam(String(mountId), "mount"));
  const driver = await loadDriver(c, mount);
  const target = assertNotMountRoot(mount, resolvePath(mount, requiredPathParam(path, "path")), "创建");
  await withDriver(mount.name, () => driver.mkdir(target));
  return c.json({ ok: true });
});

fs.post("/remove", async (c) => {
  const { mount: mountId, path } = await readJson<{ mount: number; path: string }>(c);
  const mount = await requireMount(c, intParam(String(mountId), "mount"));
  const driver = await loadDriver(c, mount);
  // 防手滑：path 必须显式给出，且不允许一键删掉整个挂载根
  const target = assertNotMountRoot(mount, resolvePath(mount, requiredPathParam(path, "path")), "删除");
  await withDriver(mount.name, () => driver.remove(target));
  return c.json({ ok: true });
});

fs.post("/rename", async (c) => {
  const { mount: mountId, from, to } = await readJson<{ mount: number; from: string; to: string }>(c);
  const mount = await requireMount(c, intParam(String(mountId), "mount"));
  const driver = await loadDriver(c, mount);
  const src = assertNotMountRoot(mount, resolvePath(mount, requiredPathParam(from, "from")), "重命名");
  const dst = assertNotMountRoot(mount, resolvePath(mount, requiredPathParam(to, "to")), "重命名到");
  if (src === dst) return c.json({ ok: true });
  await withDriver(mount.name, () => driver.rename(src, dst));
  return c.json({ ok: true });
});

fs.post("/move", async (c) => {
  const { mount: mountId, from, to } = await readJson<{ mount: number; from: string; to: string }>(c);
  const mount = await requireMount(c, intParam(String(mountId), "mount"));
  const driver = await loadDriver(c, mount);
  const src = assertNotMountRoot(mount, resolvePath(mount, requiredPathParam(from, "from")), "移动");
  const dst = assertNotMountRoot(mount, resolvePath(mount, requiredPathParam(to, "to")), "移动到");
  if (src === dst) return c.json({ ok: true });
  // 把目录挪进它自己的子目录里 = 上游行为未定义，多数驱动会丢数据，直接拦下
  if (dst.startsWith(src.replace(/\/$/, "") + "/")) throw badRequest("不能把目录移动到它自己的子目录中");
  await withDriver(mount.name, () => driver.move(src, dst));
  return c.json({ ok: true });
});

// ---------- 上传 ----------
fs.post("/upload/init", async (c) => {
  const { mount: mountId, path, size } = await readJson<{ mount: number; path: string; size: number }>(c);
  const mount = await requireMount(c, intParam(String(mountId), "mount"));
  if (!Number.isSafeInteger(size) || size < 0) throw badRequest("上传大小必须是非负整数");
  const driver = await loadDriver(c, mount);
  const target = assertNotMountRoot(mount, resolvePath(mount, requiredPathParam(path, "path")), "上传覆盖");
  const sess = await withDriver(mount.name, () => driver.createUpload(target, size));
  if (!sess || !sess.uploadUrl) throw unsupported(`「${mount.name}」当前配置不支持上传`);
  let uploadUrl = sess.uploadUrl;
  // WebDAV 代理上传：补上 mount 参数（uploadUrl 已自带 ?path=...）
  if (uploadUrl.startsWith("/api")) uploadUrl += `${uploadUrl.includes("?") ? "&" : "?"}mount=${mount.id}`;
  return c.json({ uploadUrl, method: sess.method || "PUT", headers: sess.headers || {}, formFields: sess.formFields });
});

// WebDAV 代理上传：客户端 PUT 到 /api/fs/put?mount=&path=，Worker 流式转发到上游（凭据不暴露）
fs.put("/put", async (c) => {
  const mountId = intParam(c.req.query("mount"), "mount");
  const p = requiredPathParam(c.req.query("path"), "path");
  const mount = await requireMount(c, mountId);
  const driver = await loadDriver(c, mount);
  if (!driver.putContent) throw unsupported(`「${mount.name}」不支持代理上传`);
  const target = assertNotMountRoot(mount, resolvePath(mount, p), "上传覆盖");
  const body = c.req.raw.body;
  if (!body) throw badRequest("上传内容为空");
  const rawLength = c.req.header("Content-Length");
  const size = rawLength == null ? undefined : Number(rawLength);
  if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) throw badRequest("Content-Length 非法");
  await withDriver(mount.name, () => driver.putContent!(target, body as ReadableStream, c.req.header("Content-Type"), size));
  return c.json({ ok: true });
});

// ---------- 搜索 ----------
fs.get("/search", async (c) => {
  const store = getStore(c.env);
  const kw = (c.req.query("kw") || "").trim();
  if (kw.length < 1) return c.json({ items: [] });
  if (kw.length > 128) throw badRequest("搜索关键词过长");
  const rows = await store.searchFiles(kw);
  const mountRows = await store.listMounts();
  const nameMap = new Map(mountRows.map((m) => [m.id, m.name]));
  // 只回传仍然存在且启用的挂载下的结果，避免点进去 404
  const items = rows
    .filter((r: any) => nameMap.has(r.mount_id))
    .map((r: any) => ({ ...r, mount_name: nameMap.get(r.mount_id) }));
  return c.json({ items });
});

// ---------- 分享 ----------
fs.post("/link", async (c) => {
  const store = getStore(c.env);
  const { mount: mountId, path, password, expire_hours } = await readJson<{
    mount: number;
    path: string;
    password?: string;
    expire_hours?: number;
  }>(c);
  const mount = await requireMount(c, intParam(String(mountId), "mount"));
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const hours = Number(expire_hours);
  const expire_at = Number.isFinite(hours) && hours > 0 ? Date.now() + hours * 3600_000 : null;
  await store.createShare({
    id,
    mount_id: mount.id,
    path: resolvePath(mount, pathParam(path)),
    password: password || null,
    expire_at,
  });
  return c.json({ id, url: `/s/${id}` });
});

export default fs;
