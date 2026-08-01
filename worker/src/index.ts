import { Hono } from "hono";
import type { AppEnv, Env, MountRow } from "./types";
import auth, { setupHandler } from "./routes/auth";
import mounts from "./routes/mounts";
import fs from "./routes/fs";
import dav from "./routes/dav";
import share from "./routes/share";
import oauth from "./routes/oauth";
import { buildDriver } from "./drivers/factory";
import { normalizePath, sortItems } from "./drivers";
import { getStore } from "./db/store";
import { initDb } from "./db/init";

// strict:false 让尾斜杠无关紧要（/api/mounts 与 /api/mounts/ 等价），避免前端带斜杠请求 404
const app = new Hono<AppEnv>({ strict: false });

// 首次请求时自动建表（D1 自动供给场景下 CLI 迁移可能未执行，保证应用开箱即用）
app.use("*", async (c, next) => {
  try {
    await initDb(c.env);
  } catch {
    // 建表失败不阻断静态资源等请求；DB 相关接口会自行报错
  }
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true, title: c.env.APP_TITLE }));

// 首次部署初始化入口：顶层 /setup 与 /api/auth/setup 均可触达
app.get("/setup", setupHandler);

app.route("/api/auth", auth);
app.route("/api/oauth", oauth);
app.route("/api/mounts", mounts);
app.route("/api/fs", fs);
app.route("/dav", dav);
app.route("/s", share);

// /api 未命中 -> JSON 404（不落到 SPA）
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

// SPA 回退：其余请求交给静态资源（Workers Assets 单页应用模式）
app.get("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// ---------- 后台爬取建搜索索引（Cron: 每日 03:13） ----------
async function crawl(env: Env): Promise<void> {
  const store = getStore(env);
  const results = await store.listMounts();
  const MAX_ENTRIES = 4000; // 免费档 CPU 预算保护
  for (const m of results) {
    const driver = await buildDriver(env, m);
    const queue: string[] = [normalizePath(m.root || "/")];
    let count = 0;
    while (queue.length && count < MAX_ENTRIES) {
      const dir = queue.shift() as string;
      try {
        const items = sortItems(await driver.list(dir));
        await store.upsertFileCache(m.id, items, dir);
        count += items.length;
        for (const it of items) if (it.is_dir) queue.push(it.path);
      } catch {
        // 单个目录失败跳过
      }
    }
  }
}

export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(initDb(env).then(() => crawl(env)));
  },
};
