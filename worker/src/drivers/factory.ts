import type { Driver, DriverConfig, Env, MountRow } from "../types";
import { createDriver } from "./base";
import { md5Hex } from "../util/md5";

// 统一的驱动构造：解析配置、注入挂载 ID（供 KV 令牌索引使用）、初始化。
// 所有调用点（fs / dav / share / cron）都走这里，保证一致。
//
// 为什么要缓存实例：
// 不少驱动的 init() 会发起网络请求（terabox 校验 Cookie、阿里云刷新 token…）。
// 原实现每个 HTTP 请求都重新 new + init 一次，浏览「列目录 → 点文件 → 播放」
// 这一串操作要白白多打十几次上游请求，既慢又极易撞免费档 subrequest 上限，
// 撞上之后请求被运行时掐断，前端就是「转圈到超时」。
// 同一 isolate 内按 (mountId, 配置指纹) 复用实例即可根治。

interface CacheEntry {
  driver: Driver;
  at: number;
}

const CACHE = new Map<string, CacheEntry>();
const IN_FLIGHT = new Map<string, Promise<Driver>>();
const TTL_MS = 10 * 60 * 1000; // 10 分钟后重建，保证配置/令牌不会无限期陈旧
const MAX_CACHE = 32; // isolate 内存有限，超出就淘汰最旧的

function cacheKey(mount: MountRow): string {
  // 配置指纹入 key：管理后台改了 Cookie/密钥后立刻生效，不会继续用旧实例
  return `${mount.id}:${mount.driver}:${md5Hex(mount.config_json || "")}`;
}

function evictIfNeeded(): void {
  if (CACHE.size <= MAX_CACHE) return;
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const [k, v] of CACHE) {
    if (v.at < oldestAt) {
      oldestAt = v.at;
      oldestKey = k;
    }
  }
  if (oldestKey) CACHE.delete(oldestKey);
}

export async function buildDriver(env: Env, mount: MountRow): Promise<Driver> {
  const key = cacheKey(mount);
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    // 绑定对象每次请求都要重新注入，避免持有上一个请求的 env 引用
    hit.driver.use(env);
    return hit.driver;
  }

  const running = IN_FLIGHT.get(key);
  if (running) {
    const driver = await running;
    driver.use(env);
    return driver;
  }

  const promise = (async () => {
    let cfg: DriverConfig;
    try {
      cfg = JSON.parse(mount.config_json || "{}") as DriverConfig;
    } catch {
      throw new Error(`挂载「${mount.name}」的配置不是合法 JSON，请到管理后台重新保存`);
    }
    (cfg as Record<string, unknown>)._mountId = mount.id;
    const driver = createDriver(mount.driver, cfg, env);
    await driver.init(cfg);
    CACHE.set(key, { driver, at: Date.now() });
    evictIfNeeded();
    return driver;
  })();
  IN_FLIGHT.set(key, promise);
  try {
    const driver = await promise;
    driver.use(env);
    return driver;
  } finally {
    if (IN_FLIGHT.get(key) === promise) IN_FLIGHT.delete(key);
  }
}

/** 挂载被修改/删除时清掉缓存，避免旧实例继续服务。 */
export function invalidateDriver(mountId: number): void {
  for (const k of [...CACHE.keys()]) {
    if (k.startsWith(`${mountId}:`)) CACHE.delete(k);
  }
}
