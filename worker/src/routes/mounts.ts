import { Hono } from "hono";
import type { AppEnv, AppContext } from "../types";
import { adminMiddleware } from "../middleware/auth";
import { getStore } from "../db/store";
import { listDriverNames } from "../drivers";
import { listDriverSchemas } from "../drivers/schemas";
import { isOAuthDriver } from "../util/oauth-providers";
import { invalidateDriver } from "../drivers/factory";
import { badRequest, intParam, notFound } from "../util/errors";

const mounts = new Hono<AppEnv>();
mounts.use("*", adminMiddleware);

async function readJson<T>(c: AppContext): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
}

/** 驱动名必须在注册表里。否则会建出一个「每次列目录都抛错」的幽灵挂载。 */
function assertDriver(name: string): void {
  if (!listDriverNames().includes(name)) throw badRequest(`未知驱动：${name}`);
}

function assertName(name: string): void {
  const n = name.trim();
  if (!n) throw badRequest("挂载名不能为空");
  if (n.length > 64) throw badRequest("挂载名过长（上限 64 字符）");
  // 挂载名会出现在 URL/WebDAV 路径里，禁掉分隔符避免歧义
  if (/[\/\\?#]/.test(n)) throw badRequest("挂载名不能包含 / \\ ? # 等字符");
}

// 列出所有挂载（含禁用）
mounts.get("/", async (c) => {
  const items = await getStore(c.env).listAllMounts();
  return c.json({ items });
});

// 可用驱动列表 + 完整配置 schema（供前端动态渲染表单）
mounts.get("/drivers", (c) => {
  const schemas = listDriverSchemas().map((s) => ({ ...s, oauth: isOAuthDriver(s.id) }));
  return c.json({ drivers: listDriverNames(), schemas });
});

// 新建
mounts.post("/", async (c) => {
  const body = await readJson<{
    name: string;
    driver: string;
    config?: Record<string, unknown>;
    root?: string;
    order?: number;
  }>(c);
  if (!body.name || !body.driver) throw badRequest("缺少挂载名或驱动类型");
  assertName(body.name);
  assertDriver(body.driver);

  const store = getStore(c.env);
  // 挂载名重复会让 WebDAV / 搜索结果指向不确定的目标，提前拦下
  if (await store.getMountByName(body.name.trim())) throw badRequest(`挂载名「${body.name.trim()}」已存在`);

  const id = await store.createMount({
    name: body.name.trim(),
    driver: body.driver,
    config_json: JSON.stringify(body.config ?? {}),
    root: body.root || "/",
    order: Number.isFinite(Number(body.order)) ? Number(body.order) : 0,
  });
  return c.json({ id });
});

// 更新
mounts.put("/:id", async (c) => {
  const id = intParam(c.req.param("id"), "id");
  const store = getStore(c.env);
  const existing = await store.getMount(id);
  if (!existing) throw notFound("挂载不存在");

  const body = await readJson<{
    name?: string;
    driver?: string;
    config?: Record<string, unknown>;
    root?: string;
    order?: number;
    enabled?: number;
  }>(c);

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    assertName(body.name);
    const dup = await store.getMountByName(body.name.trim());
    if (dup && dup.id !== id) throw badRequest(`挂载名「${body.name.trim()}」已被占用`);
    patch.name = body.name.trim();
  }
  if (body.driver !== undefined) {
    assertDriver(body.driver);
    patch.driver = body.driver;
  }
  if (body.config !== undefined) patch.config_json = JSON.stringify(body.config);
  if (body.root !== undefined) patch.root = body.root || "/";
  if (body.order !== undefined) patch.order = Number(body.order) || 0;
  if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;

  await store.updateMount(id, patch as any);
  invalidateDriver(id); // 立刻丢弃旧驱动实例，改完配置无需等缓存过期
  return c.json({ ok: true });
});

// 删除
mounts.delete("/:id", async (c) => {
  const id = intParam(c.req.param("id"), "id");
  const store = getStore(c.env);
  if (!(await store.getMount(id))) throw notFound("挂载不存在");
  await store.deleteMount(id);
  invalidateDriver(id);
  return c.json({ ok: true });
});

// 取单个（调试用）
mounts.get("/:id", async (c) => {
  const m = await getStore(c.env).getMount(intParam(c.req.param("id"), "id"));
  if (!m) throw notFound("挂载不存在");
  return c.json({ mount: m });
});

export default mounts;
