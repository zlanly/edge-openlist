import { Hono } from "hono";
import type { AppEnv, MountRow } from "../types";
import { getStore } from "../db/store";
import { buildDriver } from "../drivers/factory";
import { normalizePath, sortItems, basename } from "../drivers";

const share = new Hono<AppEnv>();

// 公开访问：/s/:id?pwd=xxx
share.get("/:id", async (c) => {
  const id = c.req.param("id");
  const store = getStore(c.env);
  const rec: any = await store.getShare(id);
  if (!rec) return c.text("分享不存在或已失效", 404);
  if (rec.expire_at && Date.now() > rec.expire_at) return c.text("分享已过期", 410);
  if (rec.password) {
    const pwd = c.req.query("pwd") || "";
    if (pwd !== rec.password) {
      // 未带密码或错误：返回 401，前端弹窗输入
      if (!pwd) return c.json({ error: "需要密码", needPassword: true }, 401);
      return c.text("密码错误", 403);
    }
  }
  const mount: MountRow | null = await store.getMount(rec.mount_id);
  if (!mount || !mount.enabled) return c.text("源已不可用", 404);
  const path = normalizePath(rec.path);
  const driver = await buildDriver(c.env, mount);

  const range = c.req.header("Range") || undefined;
  // 先尝试作为文件下载；失败则作为目录列出
  try {
    const res = await driver.getContent(path, range);
    if (typeof res === "string") {
      const up = await fetch(res, { headers: range ? { Range: range } : {} });
      return new Response(up.body, { status: up.status, headers: up.headers });
    }
    return res as Response;
  } catch {
    const items = sortItems(await driver.list(path));
    return c.json({ share: { name: basename(path) || mount.name, path }, items });
  }
});

export default share;
