import { Hono } from "hono";
import type { AppEnv, Env } from "./types";
import auth from "./routes/auth";
import mounts from "./routes/mounts";
import fs from "./routes/fs";
import dav from "./routes/dav";
import share from "./routes/share";
import oauth from "./routes/oauth";
import { buildDriver } from "./drivers/factory";
import { normalizePath, sortItems } from "./drivers";
import { getStore } from "./db/store";
import { initDb } from "./db/init";
import { HttpError, toHttpError } from "./util/errors";

// strict:false 让尾斜杠无关紧要（/api/mounts 与 /api/mounts/ 等价），避免前端带斜杠请求 404
const app = new Hono<AppEnv>({ strict: false });

// ---------- 建表（仅 API 路径） ----------
// 原实现挂在 "*" 上：每个静态资源请求（JS/CSS/图标…）都要 await 一次 initDb，
// 首屏几十个请求全排在 D1 建表后面 —— 这正是「页面转圈半天没反应」的一大来源。
// 现在只在 /api/* 与 /dav、/s 上执行，且结果在 isolate 内缓存，只跑一次。
const dbReady = new WeakMap<D1Database, Promise<void>>();
function ensureDb(env: Env): Promise<void> {
  if (!env.DB || typeof (env.DB as any).prepare !== "function") return Promise.resolve();
  const db = env.DB as D1Database;
  const existing = dbReady.get(db);
  if (existing) return existing;
  const task = initDb(env).catch((e) => {
    dbReady.delete(db);
    throw e;
  });
  dbReady.set(db, task);
  return task;
}

app.use("/api/*", async (c, next) => {
  await ensureDb(c.env);
  await next();
});
app.use("/dav/*", async (c, next) => {
  await ensureDb(c.env);
  await next();
});
app.use("/s/*", async (c, next) => {
  await ensureDb(c.env);
  await next();
});

// ---------- 全局错误处理 ----------
// 这是修复「莫名退回登录页」与「无响应」的核心闸门：
//  · 任何未捕获异常都变成结构化 JSON（前端 res.json() 不会再抛 SyntaxError 卡死）
//  · 驱动/上游抛的错统一为 502 upstream_error，绝不冒充 401
//  · 只有真正的会话失效才会带 code = "unauthenticated"
app.onError((err, c) => {
  const he = err instanceof HttpError ? err : toHttpError(err);
  if (he.status >= 500) {
    console.error(`[${c.req.method} ${new URL(c.req.url).pathname}] ${he.code}:`, err);
  }
  const wantsJson =
    c.req.path.startsWith("/api/") || (c.req.header("Accept") || "").includes("application/json");
  if (!wantsJson) {
    return c.text(he.message, he.status as any);
  }
  return c.json(he.toJSON(), he.status as any);
});

app.notFound((c) => {
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/dav")) {
    return c.json({ error: "接口不存在", code: "not_found" }, 404);
  }
  // 非 API：交给 SPA 回退
  return c.env.ASSETS.fetch(c.req.raw);
});

app.get("/api/health", (c) => c.json({ ok: true, title: c.env.APP_TITLE }));

// 首次部署初始化页 /setup 由前端应用自身渲染（SPA 回退兜底），
// 不再走服务端内嵌脚本页——那在部分浏览器/代理环境下脚本不执行。
// /api/auth/setup（GET 说明页 + POST 初始化接口）仍然保留。

app.route("/api/auth", auth);
app.route("/api/oauth", oauth);
app.route("/api/mounts", mounts);
app.route("/api/fs", fs);
app.route("/dav", dav);
app.route("/s", share);

// /api 未命中 -> JSON 404（不落到 SPA）
app.all("/api/*", (c) => c.json({ error: "接口不存在", code: "not_found" }, 404));

// SPA 回退：其余请求交给静态资源（Workers Assets 单页应用模式）
app.get("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// ---------- 后台爬取建搜索索引（Cron: 每日 03:13） ----------
// 免费档护栏：总条目、访问目录数、耗时三重上限，任一触顶即收工。
// 原实现只有条目上限，遇到「目录极多但每个目录很少文件」的网盘会跑到 CPU 超时被杀，
// 索引写一半留下脏数据。
async function crawl(env: Env): Promise<void> {
  const store = getStore(env);
  const mountRows = await store.listMounts();
  const MAX_ENTRIES = 4000; // 免费档 CPU / D1 写配额保护
  const MAX_DIRS = 500; // 访问目录数上限
  const DEADLINE = Date.now() + 25_000; // 单次 cron 最长 25s

  for (const m of mountRows) {
    if (Date.now() > DEADLINE) break;
    let driver;
    try {
      driver = await buildDriver(env, m);
    } catch (e) {
      console.error(`crawl: 挂载「${m.name}」驱动初始化失败`, e);
      continue;
    }
    const queue: string[] = [normalizePath(m.root || "/")];
    const seen = new Set<string>(queue);
    let count = 0;
    let dirs = 0;
    while (queue.length && count < MAX_ENTRIES && dirs < MAX_DIRS && Date.now() < DEADLINE) {
      const dir = queue.shift() as string;
      dirs++;
      try {
        const items = sortItems(await driver.list(dir));
        await store.upsertFileCache(m.id, items, dir);
        count += items.length;
        for (const it of items) {
          // 去重：软链/自引用目录会让 BFS 无限循环
          if (it.is_dir && !seen.has(it.path)) {
            seen.add(it.path);
            queue.push(it.path);
          }
        }
      } catch (e) {
        console.error(`crawl: 目录 ${dir} 读取失败`, e);
      }
    }
  }
}

export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(
      initDb(env)
        .then(() => crawl(env))
        .catch((e) => console.error("scheduled crawl failed", e))
    );
  },
};
