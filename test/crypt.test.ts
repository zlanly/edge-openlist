// crypt 驱动的 rclone 互通自验证：
//  1) 纯密码学层（Cipher）对照 rclone 权威黄金向量：scrypt、secretbox 文件内容（file1/file16）、
//     文件名 EME+base32/base64、obscure 解码。
//  2) 驱动端到端：用字节保真的内存后端（mem）作为底层，验证加密落盘 / 解密读取 / 文件名密文 /
//     Range 请求 / 与真实 rclone 密文互通（直接喂入 file1/file16 向量，driver 解密得到明文）。
//
// 说明：仅验证逻辑与线格式，真实网盘需对应账号凭据。运行：npm test（tsx test/crypt.test.ts）

import assert from "node:assert";
import { registerDriver, createDriver, basename, joinPath, normalizePath, parentPath } from "../worker/src/drivers/base";
// 注意：不导入 drivers/index（其会加载 lanzou 等含非 JS 语法 (?i) 正则的驱动，见下方修复）。
// 本测试仅依赖 mem（本地注册）+ crypt（直接引入）。
import { Cipher } from "../worker/src/crypto/crypt-cipher";
import { reveal } from "../worker/src/crypto/obscure";
import { scrypt } from "../worker/src/crypto/scrypt";
import type { Driver, DriverConfig, Env, FileItem, UploadSession } from "../worker/src/types";
import { CloudBase } from "../worker/src/drivers/cloud-base";
// 静态导入 crypt，使其 factory->base 与测试共享同一模块实例（tsx 下动态 import 会让测试侧 base 与 crypt 的 base 分属两个 registry）。
import { CryptDriver } from "../worker/src/drivers/crypt";

// ---------- 字节保真内存后端（用于驱动联调，不依赖网络） ----------
// 按 mountId 共享存储：CryptDriver 通过 buildDriver 创建的子 MemDriver 与测试中直接构造的
// MemDriver 只要 mountId 相同即共享同一棵内存树，便于验证“底层落盘的是 rclone 密文”。
const ROOTS = new Map<number, MemNode>();
interface MemNode {
  is_dir: boolean;
  data?: Uint8Array;
  size: number;
  modified: number;
  children: Map<string, MemNode>;
}
function getRoot(mountId: number): MemNode {
  let r = ROOTS.get(mountId);
  if (!r) {
    r = { is_dir: true, size: 0, modified: Date.now(), children: new Map() };
    ROOTS.set(mountId, r);
  }
  return r;
}
class MemDriver extends CloudBase {
  readonly id = "mem";
  private root!: MemNode;
  private get mountId(): number {
    return Number((this.cfg as Record<string, unknown>)._mountId) || 0;
  }
  protected async hdrs() {
    return {};
  }
  async init(cfg: DriverConfig) {
    await super.init(cfg);
    this.root = getRoot(this.mountId);
  }
  private resolve(p: string): MemNode | null {
    const parts = normalizePath(p).replace(/^\//, "").split("/").filter(Boolean);
    let cur = this.root;
    for (const part of parts) {
      if (!cur.children.has(part)) return null;
      cur = cur.children.get(part)!;
    }
    return cur;
  }
  private parentOf(p: string): { parent: MemNode; name: string } | null {
    const name = basename(p);
    const par = this.resolve(parentPath(p));
    if (!par) return null;
    return { parent: par, name };
  }
  async list(path: string): Promise<FileItem[]> {
    const node = this.resolve(path);
    if (!node || !node.is_dir) throw new Error("目录不存在: " + path);
    const items: FileItem[] = [];
    for (const [name, c] of node.children) {
      items.push({ name, path: joinPath(path, name), is_dir: c.is_dir, size: c.size, modified: c.modified });
    }
    items.sort((a, b) => (a.is_dir !== b.is_dir ? (a.is_dir ? -1 : 1) : a.name.localeCompare(b.name)));
    return items;
  }
  async get(path: string): Promise<FileItem> {
    const node = this.resolve(path);
    if (!node) throw new Error("文件不存在: " + path);
    return { name: basename(path), path, is_dir: node.is_dir, size: node.size, modified: node.modified };
  }
  async getContent(path: string, range?: string): Promise<Response | string> {
    const node = this.resolve(path);
    if (!node || node.is_dir || !node.data) throw new Error("不是文件: " + path);
    let data = node.data;
    if (range) {
      const m = range.match(/^bytes=(\d*)-(\d*)$/);
      let start = 0;
      let end = data.length - 1;
      if (m) {
        if (m[1] !== "") start = Number(m[1]);
        if (m[2] !== "") end = Number(m[2]);
      }
      data = data.subarray(start, Math.min(end + 1, data.length));
      return new Response(data, { status: 206 });
    }
    return new Response(data);
  }
  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: "/put", method: "PUT" };
  }
  async putContent(path: string, body: ReadableStream, _ct?: string, size?: number): Promise<void> {
    const par = this.parentOf(path);
    if (!par) throw new Error("父目录不存在");
    const buf = new Uint8Array(await new Response(body).arrayBuffer());
    par.parent.children.set(par.name, {
      is_dir: false,
      data: buf,
      size: size || buf.length,
      modified: Date.now(),
      children: new Map(),
    });
  }
  async mkdir(path: string): Promise<void> {
    const par = this.parentOf(path);
    if (!par) throw new Error("父目录不存在");
    if (!par.parent.children.has(par.name)) {
      par.parent.children.set(par.name, { is_dir: true, size: 0, modified: Date.now(), children: new Map() });
    }
  }
  async remove(path: string): Promise<void> {
    const par = this.parentOf(path);
    if (par) par.parent.children.delete(par.name);
  }
  async rename(from: string, to: string): Promise<void> {
    const par = this.parentOf(from);
    if (!par || !par.parent.children.has(par.name)) throw new Error("不存在");
    const node = par.parent.children.get(par.name)!;
    par.parent.children.delete(par.name);
    const toPar = this.parentOf(to);
    if (!toPar) throw new Error("目标父目录不存在");
    toPar.parent.children.set(basename(to), node);
  }
  async move(from: string, to: string): Promise<void> {
    await this.rename(from, to);
  }
}
registerDriver("mem", MemDriver);

// ---------- 测试环境 ----------
const kv = new Map<string, string>();
const env: any = {
  KV: { get: (k: string) => kv.get(k) ?? null, put: (k: string, v: string) => void kv.set(k, v) },
  R2: {},
  DB: {},
  ASSETS: {},
  JWT_SECRET: "x",
  APP_TITLE: "t",
};
(globalThis as any).fetch = async (_url: string | URL, _opts: any = {}) => {
  return new Response("{}", { status: 404 });
};

function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/\s+/g, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(u8: Uint8Array): string {
  return Array.from(u8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}
function streamOf(u8: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(u8); c.close(); } });
}

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log("  ✓", name);
}

async function mkCrypt(over: Record<string, unknown> = {}) {
  const cfg: any = {
    password: "mysecretpassword",
    remote_driver: "mem",
    remote_config: {},
    remote_path: "/",
    _mountId: 1,
    ...over,
  };
  const d = new CryptDriver();
  d.use(env);
  await d.init(cfg);
  return d;
}

async function main() {
  // ===== 1. scrypt 对照 Python hashlib.scrypt(b'passwd', salt=b'salt', n=1024, r=8, p=1, dklen=64) =====
  await test("scrypt 对照 Python 向量 (n=1024)", () => {
    const out = scrypt(new TextEncoder().encode("passwd"), new TextEncoder().encode("salt"), 1024, 8, 1, 64);
    assert.equal(
      bytesToHex(out).replace(/ /g, ""),
      "85a050aa4350a2ae5f7b7b815ec2fd311e37e5516ed4160c1cb102481587e130c31e886def8969a0183112aa0b8b52553f398d33ea31f7b8de2c09345ed14993",
      "scrypt 输出应与 Python hashlib.scrypt 一致",
    );
  });

  // ===== 2. 文件内容 secretbox 对照 rclone 黄金向量（空密码 => 全零密钥） =====
  const zeroCipher = new Cipher({ password: "" });
  const FILE1 = hexToBytes(
    "52 43 4c 4f 4e 45 00 00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10 11 12 13 14 15 16 17 18 09 5b 44 6c d6 23 7b bc b0 8d 09 fb 52 4c e5 65 aa",
  );
  const FILE16 = hexToBytes(
    "52 43 4c 4f 4e 45 00 00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10 11 12 13 14 15 16 17 18 b9 c4 55 2a 27 10 06 29 18 96 0a 3e 60 8c 29 b9 aa 8a 5e 1e 16 5b 6d 07 5d e4 e9 bb 36 7f d6 d4",
  );

  await test("encryptData(单字节 0x01) == rclone file1 向量", () => {
    const nonce = hexToBytes("01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10 11 12 13 14 15 16 17 18");
    const enc = zeroCipher.encryptData(new Uint8Array([0x01]), nonce);
    assert.equal(bytesToHex(enc), bytesToHex(FILE1));
  });
  await test("decryptData(file1) == [0x01]", () => {
    const dec = zeroCipher.decryptData(FILE1);
    assert.deepEqual(Array.from(dec), [0x01]);
  });
  await test("encryptData(字节 1..16) == rclone file16 向量", () => {
    const plain = new Uint8Array(16);
    for (let i = 0; i < 16; i++) plain[i] = i + 1;
    const nonce = hexToBytes("01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10 11 12 13 14 15 16 17 18");
    const enc = zeroCipher.encryptData(plain, nonce);
    assert.equal(bytesToHex(enc), bytesToHex(FILE16));
  });
  await test("decryptData(file16) == 字节 1..16", () => {
    const dec = zeroCipher.decryptData(FILE16);
    const expect = new Uint8Array(16);
    for (let i = 0; i < 16; i++) expect[i] = i + 1;
    assert.deepEqual(Array.from(dec), Array.from(expect));
  });
  await test("encryptedSize/decryptedSize 互逆 (1 / 65536 / 131072+5)", () => {
    for (const n of [1, 65536, 131072, 131077, 200000]) {
      const e = zeroCipher.encryptedSize(n);
      assert.equal(zeroCipher.decryptedSize(e), n, `n=${n}`);
    }
  });

  // ===== 3. 文件名 EME 对照 rclone 黄金向量（空密码 => 全零密钥） =====
  await test("文件名 base32 加密 '1' == p0e52nreeaj0a5ea7s64m4j72s", () => {
    const c = new Cipher({ password: "", fileNameEncoding: "base32" });
    assert.equal(c.encryptFileName("1"), "p0e52nreeaj0a5ea7s64m4j72s");
    assert.equal(c.decryptFileName("p0e52nreeaj0a5ea7s64m4j72s"), "1");
  });
  await test("文件名 base64 加密 '1' == yBxRX25ypgUVyj8MSxJnFw", () => {
    const c = new Cipher({ password: "", fileNameEncoding: "base64" });
    assert.equal(c.encryptFileName("1"), "yBxRX25ypgUVyj8MSxJnFw");
    assert.equal(c.decryptFileName("yBxRX25ypgUVyj8MSxJnFw"), "1");
  });
  await test("文件名含多段 / 中文 + 目录名加密往返", () => {
    const c = new Cipher({ password: "mysecretpassword", fileNameEncoding: "base32" });
    for (const name of ["hello.txt", "视频.mp4", "a b c", "①特殊"]) {
      const e = c.encryptFileName(name);
      assert.equal(c.decryptFileName(e), name, `文件名 ${name} 往返`);
      const de = c.encryptDirName(name);
      assert.equal(c.decryptDirName(de), name, `目录名 ${name} 往返`);
    }
  });

  // ===== 4. obscure 解码 =====
  await test("obscure.Reveal 对照 rclone 向量", () => {
    assert.equal(reveal("YWFhYWFhYWFhYWFhYWFhYQ"), "");
    assert.equal(reveal("YWFhYWFhYWFhYWFhYWFhYXMaGgIlEQ"), "potato");
    assert.equal(reveal("plaintext"), "plaintext");
  });

  // ===== 5. 非空前密码：scrypt+secretbox 集成往返（验证密钥派生正确） =====
  await test("非空密码：文件内容 encrypt/decrypt 往返 + 分块边界", () => {
    const c = new Cipher({ password: "mysecretpassword", salt: "NaCl" });
    for (const n of [0, 1, 65535, 65536, 65537, 200000]) {
      const plain = new Uint8Array(n);
      for (let i = 0; i < n; i++) plain[i] = (i * 7 + 3) & 0xff;
      const enc = c.encryptData(plain);
      assert.equal(enc.length, c.encryptedSize(n), `size n=${n}`);
      const dec = c.decryptData(enc);
      assert.deepEqual(Array.from(dec), Array.from(plain), `roundtrip n=${n}`);
    }
  });

  // ===== 6. 驱动端到端：加密落盘 / 解密读取 / 列表 / 文件名密文 =====
  await test("CryptDriver 落盘为 rclone 密文，读取还原明文 (mountId=1)", async () => {
    const d = await mkCrypt({ _mountId: 1 });
    const content = "Hello, rclone-interop crypt driver! 中文测试 🎉";
    const body = new TextEncoder().encode(content);
    await d.putContent("/note.txt", streamOf(body), "text/plain", body.length);

    // 底层 mem（同 mountId=1）中应存的是密文（非明文）
    const raw = createDriver("mem", { _mountId: 1 } as any, env) as Driver;
    await raw.init({ _mountId: 1 });
    const encItems = await raw.list("/");
    assert.equal(encItems.length, 1);
    assert.notEqual(encItems[0].name, "note.txt", "底层文件名应为密文");
    const encFile = await raw.get("/" + encItems[0].name);
    assert.ok(encFile.size > body.length, "密文大小应大于明文（含头与 MAC）");
    assert.equal(encFile.size, d["cipher"].encryptedSize(body.length), "底层密文大小应等于 encryptedSize");

    // 通过 crypt 读取还原
    const got = await d.get("/note.txt");
    assert.equal(got.name, "note.txt");
    assert.equal(got.size, body.length);
    const res: any = await d.getContent("/note.txt");
    assert.equal(await res.text(), content);
  });

  await test("CryptDriver 列表：目录与文件名均解密，大小正确 (mountId=2)", async () => {
    const d = await mkCrypt({ _mountId: 2 });
    await d.mkdir("/docs");
    await d.putContent("/docs/readme.md", streamOf(new TextEncoder().encode("readme body")), "text/plain", 11);
    const items = await d.list("/docs");
    assert.equal(items.length, 1);
    assert.equal(items[0].name, "readme.md");
    assert.equal(items[0].is_dir, false);
    assert.equal(items[0].size, 11);
    const root = await d.list("/");
    assert.equal(root.length, 1);
    assert.equal(root[0].name, "docs");
    assert.equal(root[0].is_dir, true);
  });

  await test("CryptDriver rename / remove (mountId=3)", async () => {
    const d = await mkCrypt({ _mountId: 3 });
    await d.putContent("/a.txt", streamOf(new TextEncoder().encode("AAA")), "text/plain", 3);
    await d.rename("/a.txt", "/b.txt");
    const items = await d.list("/");
    assert.equal(items.length, 1);
    assert.equal(items[0].name, "b.txt");
    const res: any = await d.getContent("/b.txt");
    assert.equal(await res.text(), "AAA");
    await d.remove("/b.txt");
    assert.equal((await d.list("/")).length, 0);
  });

  // ===== 7. 与真实 rclone 密文互通：直接把 file1/file16 向量当底层文件，driver 应解密得到明文 =====
  await test("CryptDriver 读取真实 rclone 密文 (file16) 得到字节 1..16 (mountId=7)", async () => {
    // rclone 的密文文件：文件名与内容均为密文。故以“加密后的文件名”入库，driver 才能按加密名命中并解密内容。
    // file1/file16 黄金向量使用空密码（全零密钥），故此处 crypt 也必须用 password:"" 才能匹配密钥。
    const d = await mkCrypt({ _mountId: 7, password: "" });
    const encName = (d as any).cipher.encryptFileName("real.bin");
    const mem = createDriver("mem", { _mountId: 7 } as any, env) as Driver;
    await mem.init({ _mountId: 7 });
    await mem.putContent("/" + encName, streamOf(FILE16), "application/octet-stream", FILE16.length);
    const res: any = await d.getContent("/real.bin");
    const dec = new Uint8Array(await res.arrayBuffer());
    const expect = new Uint8Array(16);
    for (let i = 0; i < 16; i++) expect[i] = i + 1;
    assert.deepEqual(Array.from(dec), Array.from(expect), "应解密出 rclone 写入的字节 1..16");
  });

  await test("CryptDriver 读取真实 rclone 密文 (file1) 得到 0x01 (mountId=8)", async () => {
    const d = await mkCrypt({ _mountId: 8, password: "" });
    const encName = (d as any).cipher.encryptFileName("r1.bin");
    const mem = createDriver("mem", { _mountId: 8 } as any, env) as Driver;
    await mem.init({ _mountId: 8 });
    await mem.putContent("/" + encName, streamOf(FILE1), "application/octet-stream", FILE1.length);
    const res: any = await d.getContent("/r1.bin");
    const dec = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual(Array.from(dec), [0x01]);
  });

  // ===== 8. Range 请求（解密视角） =====
  await test("CryptDriver Range 请求正确切片（跨块） (mountId=8)", async () => {
    const d = await mkCrypt({ _mountId: 8 }); // 复用 mountId=8（与上一测试隔离靠文件名）
    const big = new Uint8Array(200000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 3 + 5) & 0xff;
    await d.putContent("/big.bin", streamOf(big), "application/octet-stream", big.length);
    const res: any = await d.getContent("/big.bin", "bytes=70000-130000");
    assert.equal(res.status, 206);
    const slice = new Uint8Array(await res.arrayBuffer());
    assert.equal(slice.length, 130000 - 70000 + 1);
    for (let i = 0; i < slice.length; i++) {
      assert.equal(slice[i], big[70000 + i], `offset ${70000 + i}`);
    }
  });

  await test("CryptDriver 无 range 全量读取 == 明文 (mountId=9)", async () => {
    const d = await mkCrypt({ _mountId: 9 });
    const data = new Uint8Array(123456);
    for (let i = 0; i < data.length; i++) data[i] = (i * 11) & 0xff;
    await d.putContent("/full.bin", streamOf(data), "application/octet-stream", data.length);
    const res: any = await d.getContent("/full.bin");
    const out = new Uint8Array(await res.arrayBuffer());
    assert.equal(out.length, data.length);
    assert.deepEqual(Array.from(out), Array.from(data));
  });

  console.log(`\n全部 ${passed} 项 crypt 自验证通过 ✓`);
}

main().catch((e) => {
  console.error("测试失败:", e);
  process.exit(1);
});
