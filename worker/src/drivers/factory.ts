import type { Driver, DriverConfig, Env, MountRow } from "../types";
import { createDriver } from "./base";

// 统一的驱动构造：解析配置、注入挂载 ID（供 KV 令牌索引使用）、初始化。
// 所有调用点（fs / dav / share / cron）都走这里，保证一致。
export async function buildDriver(env: Env, mount: MountRow): Promise<Driver> {
  const cfg = JSON.parse(mount.config_json || "{}") as DriverConfig;
  (cfg as Record<string, unknown>)._mountId = mount.id;
  const driver = createDriver(mount.driver, cfg, env);
  await driver.init(cfg);
  return driver;
}
