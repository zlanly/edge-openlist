import { Hono } from "hono";
import type { AppEnv, MountRow } from "../types";
import { getStore } from "../db/store";
import { buildDriver } from "../drivers/factory";
import { normalizePath, sortItems, basename } from "../drivers";
import { timingSafeEqual } from "../util/auth";
import { forbidden, notFound, withDriver, HttpError } from "../util/errors";
import { assertUpstreamOk, buildContentResponse, proxyDirectLink } from "../util/content";

const share = new Hono<AppEnv>();

// 公开访问：/s/:id?pwd=xxx
share.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!id || id.length > 64) throw notFound("分享不存在或已失效");

  const store = getStore(c.env);
  const rec: any = await store.getShare(id);
  if (!rec) throw notFound("分享不存在或已失效");
  if (rec.expire_at && Date.now() > rec.expire_at) {
    throw new HttpError(410, "分享已过期", "not_found");
  }

  if (rec.password) {
    const pwd = c.req.query("pwd") || "";
    if (!pwd) {
      // 未带密码：告诉前端需要弹密码框（注意 code 不是 unauthenticated，
      // 否则前端的全局 401 处理会把访客「登出」并跳到登录页）
      return c.json({ error: "需要访问密码", code: "need_password", needPassword: true }, 401);
    }
    // 恒定时间比较，避免逐字符爆破分享密码
    if (!timingSafeEqual(pwd, String(rec.password))) throw forbidden("访问密码错误");
  }

  const mount: MountRow | null = await store.getMount(rec.mount_id);
  if (!mount || !mount.enabled) throw notFound("分享的源已不可用");

  const path = normalizePath(rec.path);
  const driver = await withDriver(mount.name, () => buildDriver(c.env, mount));
  const name = basename(path) || mount.name;
  const range = c.req.header("Range") || undefined;

  // 先判断是目录还是文件：原实现用 try(getContent) / catch(list) 试探，
  // 结果任何真实的上游故障都会被当成「这是个目录」，再触发第二次失败，
  // 最终抛出一个与真实原因完全无关的错误。改为显式判定。
  let isDir = false;
  try {
    const meta = await driver.get(path);
    isDir = !!meta?.is_dir;
  } catch {
    // 少数驱动不支持对根路径 get()，退化为「尝试列目录」
    try {
      await driver.list(path);
      isDir = true;
    } catch {
      isDir = false;
    }
  }

  if (isDir) {
    const items = sortItems(await withDriver(mount.name, () => driver.list(path)));
    // 目录分享只暴露必要字段，不泄露挂载 id / 真实完整路径
    return c.json({
      share: { name, path: "/" },
      items: items.map((it) => ({
        name: it.name,
        is_dir: it.is_dir,
        size: it.size,
        modified: it.modified,
      })),
    });
  }

  const res = await withDriver(mount.name, () => driver.getContent(path, range));
  if (typeof res === "string") {
    return proxyDirectLink(res, mount.name, name, false, range);
  }
  assertUpstreamOk(res, mount.name);
  return buildContentResponse(res, name, false);
});

export default share;
