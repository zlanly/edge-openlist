import { Hono } from "hono";
import type { AppEnv } from "../types";
import { adminMiddleware } from "../middleware/auth";
import { getStore } from "../db/store";
import { listDriverNames } from "../drivers";
import { listDriverSchemas } from "../drivers/schemas";
import { isOAuthDriver } from "../util/oauth-providers";

const mounts = new Hono<AppEnv>();
mounts.use("*", adminMiddleware);

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
  const body = await c.req.json<{ name: string; driver: string; config: Record<string, unknown>; root?: string; order?: number }>();
  if (!body.name || !body.driver) return c.json({ error: "缺少 name / driver" }, 400);
  const id = await getStore(c.env).createMount({
    name: body.name,
    driver: body.driver,
    config_json: JSON.stringify(body.config ?? {}),
    root: body.root || "/",
    order: body.order ?? 0,
  });
  return c.json({ id });
});

// 更新
mounts.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ name?: string; driver?: string; config?: Record<string, unknown>; root?: string; order?: number; enabled?: number }>();
  const patch: any = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.driver !== undefined) patch.driver = body.driver;
  if (body.config !== undefined) patch.config_json = JSON.stringify(body.config);
  if (body.root !== undefined) patch.root = body.root;
  if (body.order !== undefined) patch.order = body.order;
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  await getStore(c.env).updateMount(id, patch);
  return c.json({ ok: true });
});

// 删除
mounts.delete("/:id", async (c) => {
  await getStore(c.env).deleteMount(Number(c.req.param("id")));
  return c.json({ ok: true });
});

// 取单个（调试用）
mounts.get("/:id", async (c) => {
  const m = await getStore(c.env).getMount(Number(c.req.param("id")));
  return c.json({ mount: m });
});

export default mounts;
