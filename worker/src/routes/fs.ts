import { Hono } from "hono";
import type { AppEnv, MountRow } from "../types";
import { authMiddleware } from "../middleware/auth";
import { getMount, listMounts, upsertFileCache, searchFiles, createShare } from "../db/schema";
import { createDriver, normalizePath, sortItems, basename } from "../drivers";
import { buildDriver } from "../drivers/factory";
import type { AppContext } from "../types";

const fs = new Hono<AppEnv>();
fs.use("*", authMiddleware);

// 根据挂载记录构造并初始化驱动
async function loadDriver(c: AppContext, mount: MountRow) {
  return buildDriver(c.env, mount);
}

// 解析 path（相对挂载根）
function resolvePath(mount: MountRow, p: string): string {
  const root = normalizePath(mount.root || "/");
  const rel = normalizePath(p || "/");
  if (root === "/") return rel;
  return normalizePath(root + rel);
}

// 列出目录
fs.get("/list", async (c) => {
  const mountId = Number(c.req.query("mount"));
  const p = c.req.query("path") || "/";
  const mount = await getMount(c.env.DB, mountId);
  if (!mount || !mount.enabled) return c.json({ error: "挂载不存在" }, 404);
  const driver = await loadDriver(c, mount);
  const items = sortItems(await driver.list(resolvePath(mount, p)));
  // 写入索引（异步，不阻塞响应）
  c.executionCtx?.waitUntil?.(upsertFileCache(c.env.DB, mount.id, items, resolvePath(mount, p)));
  return c.json({ items, path: p, mount: { id: mount.id, name: mount.name } });
});

// 下载 / 预览（流式转发，透传 Range）
async function serveContent(c: any, inline: boolean) {
  const mountId = Number(c.req.query("mount"));
  const p = c.req.query("path") || "/";
  const mount = await getMount(c.env.DB, mountId);
  if (!mount || !mount.enabled) return c.json({ error: "挂载不存在" }, 404);
  const driver = await loadDriver(c, mount);
  const range = c.req.header("Range") || undefined;
  const res = await driver.getContent(resolvePath(mount, p), range);
  if (typeof res === "string") {
    const upstream = await fetch(res, { headers: range ? { Range: range } : {} });
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  }
  const name = basename(p);
  if (inline) {
    res.headers.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
  } else {
    res.headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  res.headers.set("Accept-Ranges", "bytes");
  return res;
}
fs.get("/get", (c) => serveContent(c, false));
fs.get("/raw", (c) => serveContent(c, true));

// 文件管理
fs.post("/mkdir", async (c) => {
  const { mount: mountId, path } = await c.req.json<{ mount: number; path: string }>();
  const mount = await getMount(c.env.DB, mountId);
  if (!mount) return c.json({ error: "挂载不存在" }, 404);
  const driver = await loadDriver(c, mount);
  await driver.mkdir(resolvePath(mount, path));
  return c.json({ ok: true });
});
fs.post("/remove", async (c) => {
  const { mount: mountId, path } = await c.req.json<{ mount: number; path: string }>();
  const mount = await getMount(c.env.DB, mountId);
  if (!mount) return c.json({ error: "挂载不存在" }, 404);
  const driver = await loadDriver(c, mount);
  await driver.remove(resolvePath(mount, path));
  return c.json({ ok: true });
});
fs.post("/rename", async (c) => {
  const { mount: mountId, from, to } = await c.req.json<{ mount: number; from: string; to: string }>();
  const mount = await getMount(c.env.DB, mountId);
  if (!mount) return c.json({ error: "挂载不存在" }, 404);
  const driver = await loadDriver(c, mount);
  await driver.rename(resolvePath(mount, from), resolvePath(mount, to));
  return c.json({ ok: true });
});
fs.post("/move", async (c) => {
  const { mount: mountId, from, to } = await c.req.json<{ mount: number; from: string; to: string }>();
  const mount = await getMount(c.env.DB, mountId);
  if (!mount) return c.json({ error: "挂载不存在" }, 404);
  const driver = await loadDriver(c, mount);
  await driver.move(resolvePath(mount, from), resolvePath(mount, to));
  return c.json({ ok: true });
});

// 上传初始化：返回直传 URL（R2/S3 预签名；WebDAV 返回 Worker 代理路径）
fs.post("/upload/init", async (c) => {
  const { mount: mountId, path, size } = await c.req.json<{ mount: number; path: string; size: number }>();
  const mount = await getMount(c.env.DB, mountId);
  if (!mount) return c.json({ error: "挂载不存在" }, 404);
  const driver = await loadDriver(c, mount);
  const sess = await driver.createUpload(resolvePath(mount, path), size || 0);
  let uploadUrl = sess.uploadUrl;
  // WebDAV 代理上传：补上 mount 参数
  if (uploadUrl.startsWith("/api")) uploadUrl += `&mount=${mountId}`;
  return c.json({ uploadUrl, method: sess.method || "PUT", headers: sess.headers || {}, formFields: sess.formFields });
});

// WebDAV 代理上传：客户端 PUT 到 /api/fs/put?mount=&path=，Worker 流式转发到上游（凭据不暴露）
fs.put("/put", async (c) => {
  const mountId = Number(c.req.query("mount"));
  const p = c.req.query("path") || "/";
  const mount = await getMount(c.env.DB, mountId);
  if (!mount) return c.json({ error: "挂载不存在" }, 404);
  const driver = await loadDriver(c, mount);
  if (!driver.putContent) return c.json({ error: "该驱动不支持代理上传" }, 400);
  await driver.putContent(resolvePath(mount, p), c.req.raw.body as ReadableStream, c.req.header("Content-Type"), Number(c.req.header("Content-Length") || 0));
  return c.json({ ok: true });
});

// 搜索（基于 D1 索引）
fs.get("/search", async (c) => {
  const kw = c.req.query("kw") || "";
  if (kw.length < 1) return c.json({ items: [] });
  const rows = await searchFiles(c.env.DB, kw);
  // 关联挂载名
  const mounts = await listMounts(c.env.DB);
  const nameMap = new Map(mounts.map((m) => [m.id, m.name]));
  const items = rows.map((r: any) => ({ ...r, mount_name: nameMap.get(r.mount_id) || "?" }));
  return c.json({ items });
});

// 创建分享链接
fs.post("/link", async (c) => {
  const { mount: mountId, path, password, expire_hours } = await c.req.json<{
    mount: number;
    path: string;
    password?: string;
    expire_hours?: number;
  }>();
  const mount = await getMount(c.env.DB, mountId);
  if (!mount) return c.json({ error: "挂载不存在" }, 404);
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const expire_at = expire_hours ? Date.now() + expire_hours * 3600_000 : null;
  await createShare(c.env.DB, {
    id,
    mount_id: mountId,
    path: resolvePath(mount, path),
    password: password || null,
    expire_at,
  });
  return c.json({ id, url: `/s/${id}` });
});

export default fs;
