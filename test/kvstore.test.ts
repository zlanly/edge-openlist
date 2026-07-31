// KV-only 存储层冒烟测试：用内存 mock 驱动真实 KvStore（与线上无 D1 时走同一路径），
// 验证 store 抽象在移除 D1 绑定后仍能完整工作（挂载/用户/文件索引/分享）。
import { getStore } from "../worker/src/db/store";

function mockKV() {
  const m = new Map<string, string>();
  return {
    async get(k: string) {
      return m.has(k) ? m.get(k)! : null;
    },
    async put(k: string, v: string) {
      m.set(k, v);
    },
    async delete(k: string) {
      m.delete(k);
    },
    async list({ prefix }: { prefix: string }) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined as string | undefined };
    },
  } as any;
}

let failed = false;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failed = true;
    console.error("  ✗ " + msg);
  } else {
    console.log("  ✓ " + msg);
  }
}

async function main() {
  const store = getStore({ KV: mockKV() } as any);

  // ---- 挂载 ----
  const id = await store.createMount({ name: "m1", driver: "local", config_json: "{}", root: "/", order: 1 });
  assert(id === 1, "createMount 首条 id=1 (got " + id + ")");
  const m = await store.getMount(id);
  assert(!!m && m.name === "m1", "getMount 命中");
  const byName = await store.getMountByName("m1");
  assert(!!byName && byName.id === id, "getMountByName 命中");
  await store.updateMount(id, { name: "m1b", enabled: 0 });
  const m2 = await store.getMount(id);
  assert(!!m2 && m2.name === "m1b" && m2.enabled === 0, "updateMount 改 name+enabled");
  const enabled = await store.listMounts();
  assert(enabled.length === 0, "listMounts 排除禁用项");
  const all = await store.listAllMounts();
  assert(all.length === 1, "listAllMounts 含禁用项");

  // ---- 用户 ----
  assert((await store.countUsers()) === 0, "countUsers 初始 0");
  await store.createUser("admin", "hash", "admin");
  assert((await store.countUsers()) === 1, "countUsers 创建后 1");
  const u = await store.getUserByName("admin");
  assert(!!u && u.role === "admin", "getUserByName 命中");

  // ---- 文件缓存 + 搜索 ----
  await store.upsertFileCache(id, [
    { name: "movie.mp4", path: "/movie.mp4", is_dir: false, size: 100, modified: 1 },
    { name: "folder", path: "/folder", is_dir: true, size: 0, modified: 1 },
  ] as any, "/");
  const res = await store.searchFiles("mov");
  assert(res.length === 1 && res[0].name === "movie.mp4", "searchFiles 按名过滤");
  const resDir = await store.searchFiles("folder");
  assert(resDir.length === 1 && resDir[0].is_dir === 1, "searchFiles 目录项 is_dir=1");
  // upsert 覆盖同目录旧记录
  await store.upsertFileCache(id, [{ name: "only.mp4", path: "/only.mp4", is_dir: false, size: 1, modified: 1 }] as any, "/");
  const after = await store.searchFiles("mp4");
  assert(after.length === 1 && after[0].name === "only.mp4", "upsertFileCache 覆盖同目录");

  // ---- 分享 ----
  await store.createShare({ id: "abc", mount_id: id, path: "/x", password: null, expire_at: null });
  const s = await store.getShare("abc");
  assert(!!s && s.path === "/x", "getShare 命中");
  assert((await store.getShare("nope")) === null, "getShare 未命中返回 null");

  // ---- 删除 ----
  await store.deleteMount(id);
  assert((await store.getMount(id)) === null, "deleteMount 后查不到");
  assert((await store.getMountByName("m1b")) === null, "deleteMount 同步清理 byname 索引");

  console.log(failed ? "\nKV store 冒烟测试：有失败项 ✗" : "\nKV store 冒烟测试全部通过 ✓");
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
