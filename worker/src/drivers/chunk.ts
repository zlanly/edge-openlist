import type { Driver, DriverConfig, Env, FileItem, MountRow, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath, sortItems } from "./base";
import { buildDriver } from "./factory";
import { CloudBase } from "./cloud-base";

// 分块驱动：把大文件切片存到多个底层 driver（cfg.drivers 列表 + part_size）。
// 移植自 OpenList chunk（drivers/chunk/driver.go + obj.go）：底层存储中，分块文件表现为一个以
// chunk_prefix 为前缀的“袋”目录，内部是按序号命名的分片（0,1,2...）。本实现扩展为“多底层 driver”：
//   第 i 个分片存放在 drivers[(hash(name)+i) % N] 上，袋目录在承载分片的各 driver 上创建。
// 因此不同文件分布到不同 driver，单文件的分片也可跨 driver 分布。list 聚合各底层；
// getContent 按分片顺序拼接（支持 Range，逐分片透传子区间，不缓冲整文件）；上传逐分片流式写入。
//
// 注：上游用单一 RemotePath + fs 层；本实现用多 driver + 可选 remote_path 前缀，更贴合任务说明。
// 目录结构在全部底层 driver 上冗余创建，以保证各 driver 列表聚合一致。

interface DriverSpec {
  driver: string;
  config: Record<string, unknown>;
}

export class ChunkDriver extends CloudBase {
  readonly id = "chunk";
  private specs: DriverSpec[] = [];
  private drivers: Driver[] = [];
  private partSize = 0;
  private chunkPrefix = "[openlist_chunk]";
  private customExt = "";
  private remoteRoot = "/";

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  private cfgStr(k: string): string {
    return (this.cfg as any)[k] as string;
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    this.partSize = Number(cfg.part_size) || 0;
    if (this.partSize <= 0) throw new Error("chunk: part_size 必须为正");
    this.chunkPrefix = this.cfgStr("chunk_prefix") || "[openlist_chunk]";
    this.customExt = this.cfgStr("custom_ext") || "";
    this.remoteRoot = normalizePath(this.cfgStr("remote_path") || "/");
    const raw = cfg.drivers;
    let arr: any[] = [];
    if (typeof raw === "string") {
      try { arr = JSON.parse(raw); } catch { arr = []; }
    } else if (Array.isArray(raw)) {
      arr = raw;
    }
    this.specs = arr.map((s) => ({ driver: String(s.driver || ""), config: s.config && typeof s.config === "object" ? s.config : {} }));
    if (this.specs.length === 0) throw new Error("chunk: 至少需要一个底层 driver");
  }

  private async ensureDrivers(): Promise<Driver[]> {
    if (this.drivers.length) return this.drivers;
    this.drivers = await Promise.all(
      this.specs.map((s, i) => {
        const row: MountRow = {
          id: this.mountId * 1000 + i,
          name: s.driver,
          driver: s.driver,
          config_json: JSON.stringify(s.config),
          root: "/",
          order: i,
          enabled: 1,
          created_at: Date.now(),
        };
        return buildDriver(this.env, row);
      }),
    );
    return this.drivers;
  }

  private rp(local: string): string {
    return joinPath(this.remoteRoot, local === "/" ? "" : local);
  }

  async list(path: string): Promise<FileItem[]> {
    const ds = await this.ensureDrivers();
    const rp = this.rp(path);
    const merged = new Map<string, FileItem>();
    const bags = new Map<string, Map<Driver, FileItem>>();
    for (const d of ds) {
      let items: FileItem[] = [];
      try { items = await d.list(rp); } catch { continue; }
      for (const it of items) {
        if (it.is_dir && it.name.startsWith(this.chunkPrefix)) {
          if (!bags.has(it.name)) bags.set(it.name, new Map());
          bags.get(it.name)!.set(d, it);
        } else merged.set(it.name, { ...it, path: joinPath(path, it.name) });
      }
    }
    for (const [bagName, owners] of bags) {
      const fileName = bagName.slice(this.chunkPrefix.length);
      if (merged.has(fileName)) continue;
      const parts = new Map<number, { size: number; modified: number }>();
      for (const d of owners.keys()) {
        let partItems: FileItem[] = [];
        try { partItems = await d.list(joinPath(rp, bagName)); } catch { continue; }
        for (const part of partItems) {
          const m = part.name.match(/^(\d+)(\.\w+)?$/); if (!m) continue;
          const idx = Number(m[1]);
          if (!parts.has(idx)) parts.set(idx, { size: part.size, modified: part.modified });
        }
      }
      const indexes = [...parts.keys()].sort((a, b) => a - b);
      if (!indexes.length || indexes.some((n, i) => n !== i)) continue;
      const total = indexes.reduce((sum, i) => sum + parts.get(i)!.size, 0);
      merged.set(fileName, { name: fileName, path: joinPath(path, fileName), is_dir: false, size: total, modified: parts.get(0)!.modified });
    }
    return sortItems([...merged.values()]);
  }

  async get(path: string): Promise<FileItem> {
    const items = await this.list(parentPath(path));
    const name = basename(path);
    const found = items.find((i) => i.name === name);
    if (!found) throw new Error("chunk: 不存在 " + path);
    return { ...found, path };
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const ds = await this.ensureDrivers();
    const name = basename(path), dir = parentPath(path), bagName = this.chunkPrefix + name;
    const parts = new Map<number, { driver: Driver; item: FileItem }>();
    for (const d of ds) {
      let items: FileItem[] = [];
      try { items = await d.list(this.rp(joinPath(dir, bagName))); } catch { continue; }
      for (const item of items) {
        const m = item.name.match(/^(\d+)(\.\w+)?$/); if (!m) continue;
        const idx = Number(m[1]); if (!parts.has(idx)) parts.set(idx, { driver: d, item });
      }
    }
    if (parts.size) {
      const indexes = [...parts.keys()].sort((a, b) => a - b);
      if (indexes.some((n, i) => n !== i)) throw new Error("chunk: 分片缺失，文件损坏");
      const sizes = indexes.map((i) => parts.get(i)!.item.size);
      const total = sizes.reduce((a, b) => a + b, 0);
      return this.concatStream(name, dir, parts, sizes, total, parts.get(0)!.item.modified, range);
    }
    for (const d of ds) {
      try {
        const r = await d.getContent(this.rp(path), range);
        if (typeof r === "string") return fetch(r, range ? { headers: { Range: range } } : {});
        return r;
      } catch { /* try next */ }
    }
    throw new Error("chunk: 文件不存在 " + path);
  }

  private async concatStream(
    name: string,
    dir: string,
    parts: Map<number, { driver: Driver; item: FileItem }>,
    partSizes: number[],
    total: number,
    modified: number,
    range?: string,
  ): Promise<Response> {
    const ds = await this.ensureDrivers();
    const base = hashName(name);
    const ext = this.customExt;
    let start = 0;
    let requestedLen: number | null = null;
    if (range) {
      const r = parseRange(range, total);
      if (!r) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
      start = r.offset; requestedLen = r.length;
    }
    const end = requestedLen != null ? Math.min(total, start + requestedLen) : total;
    if (start >= total && total > 0) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    const streams: ReadableStream[] = [];
    let offset = 0;
    for (let i = 0; i < partSizes.length; i++) {
      const ps = partSizes[i] || 0;
      if (ps === 0) continue;
      const pStart = offset;
      const pEnd = offset + ps;
      offset = pEnd;
      if (pEnd <= start) continue;
      if (pStart >= end) break;
      const localStart = Math.max(0, start - pStart);
      const localEnd = Math.min(ps, end - pStart);
      const owner = parts.get(i);
      if (!owner) throw new Error(`chunk: 缺少分片 ${i}`);
      const owning = owner.driver;
      const pp = this.rp(joinPath(joinPath(dir, this.chunkPrefix + name), owner.item.name));
      let partStream: ReadableStream;
      if (localStart === 0 && localEnd === ps) {
        const r = await owning.getContent(pp);
        partStream = typeof r === "string" ? (await fetch(r)).body! : r.body!;
      } else {
        const rr = `bytes=${localStart}-${localEnd - 1}`;
        const r = await owning.getContent(pp, rr);
        partStream = typeof r === "string" ? (await fetch(r, { headers: { Range: rr } })).body! : r.body!;
      }
      streams.push(partStream);
    }
    const combined = streams.length === 1 ? streams[0] : combineStreams(streams);
    if (range) {
      return new Response(combined, {
        status: 206,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes ${start}-${end - 1}/${total}`,
          "Content-Length": String(Math.max(0, end - start)),
          "Accept-Ranges": "bytes",
        },
      });
    }
    return new Response(combined, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(total) } });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "chunk" } };
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, _size?: number): Promise<void> {
    const ds = await this.ensureDrivers();
    const name = basename(path);
    const dir = parentPath(path);
    const base = hashName(name);
    const ext = this.customExt;
    const bagDir = this.rp(joinPath(dir, this.chunkPrefix + name));
    const ensured = new Set<number>();
    const reader = body.getReader();
    let buf = new Uint8Array(0);
    let partIndex = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf = concatBuf(buf, value);
        while (buf.length >= this.partSize) {
          const chunk = buf.subarray(0, this.partSize);
          buf = buf.subarray(this.partSize);
          const owning = ds[(base + partIndex) % ds.length];
          const pp = this.rp(joinPath(joinPath(dir, this.chunkPrefix + name), String(partIndex) + ext));
          if (!ensured.has((base + partIndex) % ds.length)) {
            await owning.mkdir(bagDir).catch(() => {});
            ensured.add((base + partIndex) % ds.length);
          }
          if (!owning.putContent) throw new Error(`chunk: 底层驱动「${owning.id}」不支持分片上传`);
          await owning.putContent(pp, bufToStream(chunk));
          partIndex++;
        }
      }
      if (buf.length > 0 || partIndex === 0) {
        const owningIdx = (base + partIndex) % ds.length;
        const owning = ds[owningIdx];
        const pp = this.rp(joinPath(joinPath(dir, this.chunkPrefix + name), String(partIndex) + ext));
        if (!ensured.has(owningIdx)) {
          await owning.mkdir(bagDir).catch(() => {});
          ensured.add(owningIdx);
        }
        if (!owning.putContent) throw new Error(`chunk: 底层驱动「${owning.id}」不支持分片上传`);
        await owning.putContent(pp, bufToStream(buf));
        partIndex++;
      }
    } finally {
      reader.releaseLock();
    }
  }

  async mkdir(path: string): Promise<void> {
    const ds = await this.ensureDrivers();
    const rp = this.rp(path);
    await Promise.allSettled(ds.map((d) => d.mkdir(rp)));
  }

  async remove(path: string): Promise<void> {
    const ds = await this.ensureDrivers();
    const bagName = this.chunkPrefix + basename(path);
    const bagDir = this.rp(joinPath(parentPath(path), bagName));
    let removed = false;
    await Promise.allSettled(
      ds.map(async (d) => {
        await d.remove(bagDir);
        removed = true;
      }),
    );
    if (removed) return;
    const rp = this.rp(path);
    for (const d of ds) {
      try {
        await d.remove(rp);
        return;
      } catch {
        // try next
      }
    }
    throw new Error("chunk: 不存在 " + path);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.move(from, to);
  }

  async move(from: string, to: string): Promise<void> {
    const ds = await this.ensureDrivers();
    const fromBag = this.chunkPrefix + basename(from);
    const toBag = this.chunkPrefix + basename(to);
    const fromDir = this.rp(parentPath(from));
    const toDir = this.rp(parentPath(to));
    let did = false;
    await Promise.allSettled(
      ds.map((d) => d.rename(joinPath(fromDir, fromBag), joinPath(toDir, toBag)).then(() => (did = true))),
    );
    if (did) return;
    // 真实文件直通（尽力而为）
    for (const d of ds) {
      try {
        await d.move(this.rp(from), this.rp(to));
        return;
      } catch {
        // try next
      }
    }
  }
}

function hashName(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function concatBuf(a: Uint8Array, b: Uint8Array): Uint8Array {
  const o = new Uint8Array(a.length + b.length);
  o.set(a, 0);
  o.set(b, a.length);
  return o;
}

function bufToStream(buf: Uint8Array): ReadableStream {
  return new ReadableStream({
    start(controller) {
      if (buf.length) controller.enqueue(buf);
      controller.close();
    },
  });
}

function combineStreams(streams: ReadableStream[]): ReadableStream {
  let idx = 0;
  let cur: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream({
    async pull(controller) {
      while (idx < streams.length) {
        if (!cur) cur = streams[idx].getReader() as ReadableStreamDefaultReader<Uint8Array>;
        const { done, value } = await cur.read();
        if (done) {
          cur = null;
          idx++;
          continue;
        }
        controller.enqueue(value);
        return;
      }
      controller.close();
    },
    cancel() {
      cur?.cancel();
    },
  });
}

function parseRange(header: string, total: number): { offset: number; length: number } | null {
  const m = header.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m || total < 0) return null;
  if (m[1] === "" && m[2] !== "") {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || total === 0) return null;
    return { offset: Math.max(0, total - suffix), length: Math.min(suffix, total) };
  }
  const offset = Number(m[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= total) return null;
  const end = m[2] === "" ? total - 1 : Number(m[2]);
  if (!Number.isSafeInteger(end) || end < offset) return null;
  const bounded = Math.min(end, total - 1);
  return { offset, length: bounded - offset + 1 };
}
