import type { Driver, DriverConfig, Env, FileItem, MountRow, UploadSession } from "../types";
import { basename, joinPath, normalizePath, parentPath } from "./base";
import { buildDriver } from "./factory";
import { CloudBase } from "./cloud-base";
import {
  Cipher,
  FILE_HEADER_SIZE,
  FILE_NONCE_SIZE,
  BLOCK_DATA_SIZE,
  BLOCK_SIZE,
} from "../crypto/crypt-cipher";
import { reveal } from "../crypto/obscure";

// crypt 驱动：在另一个底层驱动之上，按 rclone 线格式加密文件名与文件内容。
// 密钥派生（scrypt）、文件内容（NaCl secretbox / XSalsa20-Poly1305 + 24 字节 nonce）、
// 文件名（EME(AES-256) + base32hex/base64）均与 rclone crypt 完全互通：
// 可直接读写由 rclone 加密的存储，反之亦然。详见 ../crypto/crypt-cipher.ts。
//
// 配置（与 rclone crypt 对应）：
//   password                   明文或 obscure 混淆后的密码（自动 reveal）
//   password2 / salt           可选；若设置则作为 scrypt 盐（rclone: password2 即盐）
//   remote_driver / remote_config / remote_path  底层驱动及存放子路径
//   filename_encryption        standard(默认) | obfuscate | off
//   filename_encoding          base32(默认) | base64
//   directory_name_encryption  true(默认) | false
//   suffix                     off 模式后缀，默认 ".bin"

export class CryptDriver extends CloudBase {
  readonly id = "crypt";
  private cipher!: Cipher;
  private sub!: Driver;
  private remoteRoot = "/";

  protected async hdrs(): Promise<Record<string, string>> {
    return {};
  }

  private cfgStr(k: string): string {
    const v = (this.cfg as Record<string, unknown>)[k];
    return v == null ? "" : String(v);
  }

  async init(cfg: DriverConfig): Promise<void> {
    await super.init(cfg);
    const password = reveal(this.cfgStr("password"));
    let salt = this.cfgStr("salt") || "";
    if (this.cfgStr("password2")) salt = reveal(this.cfgStr("password2")); // rclone: password2 是 obscure 后的盐

    const dirEncRaw = this.cfgStr("directory_name_encryption");
    const dirNameEncrypt = dirEncRaw === "" ? true : dirEncRaw === "true" || dirEncRaw === "1";

    this.cipher = new Cipher({
      password,
      salt: salt || undefined,
      fileNameMode: (this.cfgStr("filename_encryption") || "standard") as any,
      fileNameEncoding: (this.cfgStr("filename_encoding") || "base32") as any,
      dirNameEncrypt,
      suffix: this.cfgStr("suffix") || ".bin",
    });

    this.remoteRoot = normalizePath(this.cfgStr("remote_path") || "/");
    const cfgObj = this.cfg.remote_config && typeof this.cfg.remote_config === "object" ? this.cfg.remote_config : {};
    const row: MountRow = {
      id: this.mountId,
      name: this.cfgStr("remote_driver") || "crypt",
      driver: this.cfgStr("remote_driver") || "",
      config_json: JSON.stringify(cfgObj),
      root: "/",
      order: 0,
      enabled: 1,
      created_at: Date.now(),
    };
    this.sub = await buildDriver(this.env, row);
  }

  private async remote(): Promise<Driver> {
    return this.sub;
  }

  // 路径加密：末段按文件名加密（encryptFileName），非末段目录按 encryptDirName（受 dirNameEncrypt 控制）。
  private async encPath(path: string): Promise<string> {
    const p = normalizePath(path).replace(/^\//, "");
    if (p === "") return this.remoteRoot === "/" ? "/" : this.remoteRoot;
    const segs = p.split("/");
    const enc = await Promise.all(segs.map((s, i) => this.encSeg(s, i === segs.length - 1)));
    return joinPath(this.remoteRoot, enc.join("/"));
  }

  private async encSeg(s: string, isLast: boolean): Promise<string> {
    if (!isLast && !this.cipher.dirNameEncrypt) return s; // 中间目录明文
    return this.cipher.encryptFileName(s);
  }

  // rclone 列表项统一按文件名解密（目录在创建时也是以文件名为末段加密）；dirNameEncrypt=false 时目录名本就明文。
  private async decSeg(s: string, isDir = false): Promise<string> {
    return isDir && !this.cipher.dirNameEncrypt ? s : this.cipher.decryptFileName(s);
  }

  private decryptedSize(e: number): number {
    return this.cipher.decryptedSize(e);
  }

  async list(path: string): Promise<FileItem[]> {
    const d = await this.remote();
    const items = await d.list(await this.encPath(path));
    const out: FileItem[] = [];
    for (const o of items) {
      const isDir = o.is_dir;
      const name = await this.decSeg(o.name, isDir);
      out.push({
        name,
        path: joinPath(path, name),
        is_dir: isDir,
        size: isDir ? o.size : this.decryptedSize(o.size),
        modified: o.modified,
      });
    }
    return out;
  }

  async get(path: string): Promise<FileItem> {
    const d = await this.remote();
    const o = await d.get(await this.encPath(path));
    const name = await this.decSeg(o.name, o.is_dir);
    return {
      name,
      path,
      is_dir: o.is_dir,
      size: o.is_dir ? o.size : this.decryptedSize(o.size),
      modified: o.modified,
    };
  }

  // 取底层响应体（直链字符串则 fetch，Response 则取 body 流）。
  private async bodyStream(r: Response | string, rangeHeader?: string): Promise<ReadableStream<Uint8Array>> {
    if (typeof r === "string") {
      const resp = await fetch(r, rangeHeader ? { headers: { Range: rangeHeader } } : {});
      return resp.body!;
    }
    return r.body!;
  }

  private async readBytes(r: Response | string): Promise<Uint8Array> {
    if (typeof r === "string") {
      const resp = await fetch(r);
      return new Uint8Array(await resp.arrayBuffer());
    }
    return new Uint8Array(await r.arrayBuffer());
  }

  async getContent(path: string, range?: string): Promise<Response | string> {
    const d = await this.remote();
    const remotePath = await this.encPath(path);

    if (!range) {
      const r = await d.getContent(remotePath);
      const body = await this.bodyStream(r);
      return new Response(body.pipeThrough(this.cipher.makeDecryptStream(0)), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }

    // Range（解密视角）-> 加密视角：先取 32 字节头拿 nonce，再按 64KiB 块对齐请求。
    const encFile = await d.get(remotePath);
    const total = this.decryptedSize(encFile.size);
    const { offset, length } = resolveRange(range, total);
    if (offset >= total || length === 0) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }

    const b0 = Math.floor(offset / BLOCK_DATA_SIZE);
    const b1 = Math.floor((offset + length - 1) / BLOCK_DATA_SIZE);
    let encStart = FILE_HEADER_SIZE + b0 * BLOCK_SIZE;
    let encEnd = FILE_HEADER_SIZE + (b1 + 1) * BLOCK_SIZE - 1;
    if (encEnd >= encFile.size) encEnd = encFile.size - 1;

    // 头（含 nonce）
    const headerBytes = await this.readBytes(await d.getContent(remotePath, `bytes=0-${FILE_HEADER_SIZE - 1}`));
    // 数据块（已对齐到块边界）
    const dataStream = await this.bodyStream(await d.getContent(remotePath, `bytes=${encStart}-${encEnd}`));

    // 拼接 [头 + 数据] 并解密；startBlock=b0 使首块使用正确 nonce。
    const combined = prependBytes(headerBytes, dataStream);
    const decrypted = combined.pipeThrough(this.cipher.makeDecryptStream(b0));
    const skip = offset - b0 * BLOCK_DATA_SIZE;
    const out = decrypted.pipeThrough(makeSkipLimit(skip, length));

    return new Response(out, {
      status: 206,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Range": `bytes ${offset}-${offset + length - 1}/${total}`,
        "Content-Length": String(length),
        "Accept-Ranges": "bytes",
      },
    });
  }

  async createUpload(path: string, _size: number): Promise<UploadSession> {
    return { uploadUrl: `/api/fs/put?path=${encodeURIComponent(path)}`, method: "PUT", headers: { "x-driver": "crypt" } };
  }

  async putContent(path: string, body: ReadableStream, _ct?: string, _size?: number): Promise<void> {
    const d = await this.remote();
    if (!d.putContent) throw new Error("crypt 底层驱动不支持代理上传");
    const encStream = body.pipeThrough(this.cipher.makeEncryptStream());
    await d.putContent(await this.encPath(path), encStream);
  }

  async mkdir(path: string): Promise<void> {
    const d = await this.remote();
    const parent = await this.encPath(parentPath(path));
    await d.mkdir(joinPath(parent, await this.encSeg(basename(path), true)));
  }
  async remove(path: string): Promise<void> {
    const d = await this.remote();
    await d.remove(await this.encPath(path));
  }
  async rename(from: string, to: string): Promise<void> {
    const d = await this.remote();
    const toParent = await this.encPath(parentPath(to));
    await d.rename(await this.encPath(from), joinPath(toParent, await this.encSeg(basename(to), true)));
  }
  async move(from: string, to: string): Promise<void> {
    await this.rename(from, to);
  }
}

function resolveRange(header: string, total: number): { offset: number; length: number } {
  const m = header.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return { offset: 0, length: total };
  if (m[1] === "" && m[2] !== "") {
    const suffix = Number(m[2]);
    const offset = Math.max(0, total - suffix);
    return { offset, length: total - offset };
  }
  const offset = Number(m[1] || "0");
  let length = total - offset;
  if (m[2] !== "") length = Number(m[2]) - offset + 1;
  return { offset, length: Math.max(0, length) };
}

// 在可读流前拼接一段固定前缀字节（用于 Range 请求补回 32 字节头）。
function prependBytes(prefix: Uint8Array, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(prefix);
        return;
      }
      return reader.read().then(({ done, value }) => {
        if (done) controller.close();
        else controller.enqueue(value);
      });
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

// 跳过前 skip 字节，最多保留 limit 字节。
function makeSkipLimit(skip: number, limit: number): TransformStream<Uint8Array, Uint8Array> {
  let pos = 0; // 已处理的解密明文偏移
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk: Uint8Array, controller) {
      if (pos >= skip + limit) return;
      let c = chunk;
      if (pos < skip) {
        const adv = Math.min(skip - pos, c.length);
        c = c.subarray(adv);
        pos += adv;
      }
      if (c.length > 0 && pos < skip + limit) {
        const keep = Math.min(limit - (pos - skip), c.length);
        controller.enqueue(c.subarray(0, keep));
        pos += keep;
      }
    },
  });
}
