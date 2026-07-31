import type { Env } from "../types";

// 运行时自动建表：覆盖「Deploy 按钮未执行 CLI 迁移」的场景（例如按钮沿用默认的
// `npx wrangler deploy` 而非 package.json 的 deploy 脚本）。D1 自动供给后会拿到空库，
// 首次请求时这里用 CREATE TABLE IF NOT EXISTS 把表建好，应用即可直接使用；
// 与 `wrangler d1 migrations apply` 完全幂等、可并存。
// 与 migrations/0001_init.sql 保持同步。
const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    created_at    INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    driver      TEXT NOT NULL,
    config_json TEXT NOT NULL,
    root        TEXT NOT NULL DEFAULT '/',
    \`order\`     INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS file_cache (
    mount_id  INTEGER NOT NULL,
    path      TEXT NOT NULL,
    name      TEXT NOT NULL,
    size      INTEGER NOT NULL DEFAULT 0,
    is_dir    INTEGER NOT NULL DEFAULT 0,
    modified  INTEGER NOT NULL DEFAULT 0,
    etag      TEXT,
    cached_at INTEGER NOT NULL,
    PRIMARY KEY (mount_id, path)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_file_cache_name ON file_cache(mount_id, name)`,
  `CREATE TABLE IF NOT EXISTS shares (
    id         TEXT PRIMARY KEY,
    mount_id   INTEGER NOT NULL,
    path       TEXT NOT NULL,
    password   TEXT,
    expire_at  INTEGER,
    created_at INTEGER NOT NULL
  )`,
];

let initPromise: Promise<void> | null = null;

export function initDb(env: Env): Promise<void> {
  if (!env.DB || typeof (env.DB as any).prepare !== "function") {
    return Promise.resolve(); // 无 DB 绑定时跳过（纯静态/测试场景）
  }
  if (!initPromise) {
    initPromise = (async () => {
      for (const sql of STATEMENTS) {
        await (env.DB as any).prepare(sql).run();
      }
    })().catch((e) => {
      initPromise = null; // 失败则下次请求重试，不永久卡死
      throw e;
    });
  }
  return initPromise;
}
