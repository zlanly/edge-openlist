// rclone crypt 线格式兼容层（与 rclone 的 rcCrypt.Cipher 等价）。
// 关键常量 / 行为严格对照 github.com/rclone/rclone/backend/crypt/cipher.go：
//   - 文件内容：magic("RCLONE\0\0", 8) + 24 字节随机 nonce 头，
//     之后按 64 KiB(65536) 分块，每块 = secretbox.Seal(明文块, nonce_i, dataKey)
//     （NaCl secretbox = XSalsa20-Poly1305，overhead=16）。nonce 为 24 字节大端计数器
//     （LSB = 最后一字节），首块使用头里的 nonce 原值，每个块 seal 之后才 +1。
//   - 密钥派生：scrypt(password, salt, N=16384, r=8, p=1, 80) 拆出
//     dataKey[0:32] + nameKey[32:64] + nameTweak[64:80]；空密码 => 全零密钥（测试模式）。
//     salt 为空 => 使用 defaultSalt(16B)；否则 saltBytes = []byte(salt)。
//   - 文件名（standard）：PKCS7 对齐到 16 => EME(AES-256, tweak=nameTweak) => base32hex / base64url 编码。
//   - 文件名（obfuscate）：逐字节旋转 + base64url 编码（非加密）。
//   - 文件名（off）：明文 + suffix（默认 ".bin"）。
// 所有密码学原语均为纯 TS（secretbox/sha256/scrypt/aes/eme/base32），零外部依赖，可在 CF Worker 运行。

import { AES } from "./aes";
import { secretboxSeal, secretboxOpen } from "./tweetnacl";
import { scrypt } from "./scrypt";
import { transform, DirectionEncrypt, DirectionDecrypt } from "./eme";
import { pkcs7Pad, pkcs7Unpad } from "./pkcs7";
import { base32HexEncode, base32HexDecode } from "./base32hex";

export const FILE_MAGIC = new Uint8Array([0x52, 0x43, 0x4c, 0x4f, 0x4e, 0x45, 0x00, 0x00]); // "RCLONE\0\0"
export const FILE_MAGIC_SIZE = 8;
export const FILE_NONCE_SIZE = 24;
export const FILE_HEADER_SIZE = 32; // magic(8) + nonce(24)
export const BLOCK_HEADER_SIZE = 16; // secretbox.Overhead
export const BLOCK_DATA_SIZE = 65536; // 64 KiB
export const BLOCK_SIZE = BLOCK_HEADER_SIZE + BLOCK_DATA_SIZE; // 65552
export const NAME_CIPHER_BLOCK_SIZE = 16;
export const DEFAULT_SALT = new Uint8Array([
  0xa8, 0x0d, 0xf4, 0x3a, 0x8f, 0xbd, 0x03, 0x08, 0xa7, 0xca, 0xb8, 0x3e, 0x58, 0x1f, 0x86, 0xb1,
]);

export type FileNameEncoding = "base32" | "base64";
export type FileNameMode = "standard" | "obfuscate" | "off";

export interface CipherOptions {
  /** 明文（已 reveal 的）密码；空字符串 => 全零密钥（与 rclone 测试模式一致）。 */
  password: string;
  /** 盐字符串（literal bytes）；空/undefined => defaultSalt。 */
  salt?: string;
  fileNameMode?: FileNameMode;
  fileNameEncoding?: FileNameEncoding;
  /** 目录名是否加密（rclone directory_name_encryption，默认 true）。 */
  dirNameEncrypt?: boolean;
  /** off 模式追加的后缀（默认 ".bin"）。 */
  suffix?: string;
}

function randomBytes(n: number): Uint8Array {
  const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!webCrypto?.getRandomValues) throw new Error("当前运行环境不支持安全随机数");
  return webCrypto.getRandomValues(new Uint8Array(n));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const o = new Uint8Array(a.length + b.length);
  o.set(a, 0);
  o.set(b, a.length);
  return o;
}

// 大端递增（LSB = 最后一字节），加 1，带进位。
function incrementNonce(nonce: Uint8Array): void {
  for (let i = nonce.length - 1; i >= 0; i--) {
    if (nonce[i] === 0xff) {
      nonce[i] = 0;
    } else {
      nonce[i]++;
      break;
    }
  }
}

function b64urlRawEncode(u8: Uint8Array): string {
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlRawDecode(s: string): Uint8Array {
  let b = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4 !== 0) b += "=";
  const bin = atob(b);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export class Cipher {
  readonly dataKey: Uint8Array;
  readonly nameKey: Uint8Array;
  readonly nameTweak: Uint8Array;
  private blockCipher: AES;
  readonly fileNameMode: FileNameMode;
  readonly fileNameEncoding: FileNameEncoding;
  readonly dirNameEncrypt: boolean;
  readonly suffix: string;

  constructor(opts: CipherOptions) {
    this.fileNameMode = opts.fileNameMode ?? "standard";
    this.fileNameEncoding = opts.fileNameEncoding ?? "base32";
    this.dirNameEncrypt = opts.dirNameEncrypt ?? true;
    this.suffix = opts.suffix ?? ".bin";

    let key: Uint8Array;
    if (!opts.password) {
      // 空密码 => 全零密钥（rclone 测试模式，文件名/内容仍加密）
      key = new Uint8Array(80);
    } else {
      const saltBytes = opts.salt ? enc.encode(opts.salt) : DEFAULT_SALT;
      key = scrypt(enc.encode(opts.password), saltBytes, 16384, 8, 1, 80);
    }
    this.dataKey = key.subarray(0, 32);
    this.nameKey = key.subarray(32, 64);
    this.nameTweak = key.subarray(64, 80);
    this.blockCipher = new AES(this.nameKey);
  }

  // ---------- 文件内容：大小 ----------
  encryptedSize(plainSize: number): number {
    const blocks = Math.floor(plainSize / BLOCK_DATA_SIZE);
    const residue = plainSize % BLOCK_DATA_SIZE;
    let s = FILE_HEADER_SIZE + blocks * BLOCK_SIZE;
    if (residue !== 0) s += BLOCK_HEADER_SIZE + residue;
    return s;
  }
  decryptedSize(encSize: number): number {
    let s = encSize - FILE_HEADER_SIZE;
    if (s < 0) return 0;
    const blocks = Math.floor(s / BLOCK_SIZE);
    const residue = s % BLOCK_SIZE;
    let d = blocks * BLOCK_DATA_SIZE;
    if (residue !== 0) {
      const r = residue - BLOCK_HEADER_SIZE;
      if (r <= 0) return 0;
      d += r;
    }
    return d;
  }

  // ---------- 文件内容：非流式（小文件/自测用） ----------
  // 传入 fixedNonce 可复现加密（用于与 rclone 黄金向量对照）；缺省随机。
  encryptData(plain: Uint8Array, fixedNonce?: Uint8Array): Uint8Array {
    const nonce = fixedNonce ? fixedNonce.slice(0, FILE_NONCE_SIZE) : randomBytes(FILE_NONCE_SIZE);
    const out: Uint8Array[] = [concat(FILE_MAGIC, nonce)];
    for (let off = 0; off < plain.length; off += BLOCK_DATA_SIZE) {
      const chunk = plain.subarray(off, Math.min(off + BLOCK_DATA_SIZE, plain.length));
      // rclone 约定：首个数据块使用头里的 nonce 原值，seal 之后才递增（increment 在 seal 之后）。
      out.push(secretboxSeal(chunk, nonce, this.dataKey));
      incrementNonce(nonce);
    }
    return merge(out);
  }

  decryptData(enc: Uint8Array): Uint8Array {
    if (enc.length < FILE_HEADER_SIZE) throw new Error("加密文件过短（缺少头）");
    const nonce = enc.subarray(FILE_MAGIC_SIZE, FILE_HEADER_SIZE).slice();
    const out: Uint8Array[] = [];
    let pos = FILE_HEADER_SIZE;
    while (pos < enc.length) {
      let len = enc.length - pos;
      if (len >= BLOCK_SIZE) len = BLOCK_SIZE;
      const block = enc.subarray(pos, pos + len);
      const plain = secretboxOpen(block, nonce, this.dataKey);
      if (!plain) throw new Error("文件内容解密失败（密钥错误或数据损坏）");
      out.push(plain);
      incrementNonce(nonce);
      pos += len;
    }
    return merge(out);
  }

  // ---------- 文件内容：流式（大文件） ----------
  makeEncryptStream(): TransformStream<Uint8Array, Uint8Array> {
    const dataKey = this.dataKey;
    const nonce = randomBytes(FILE_NONCE_SIZE);
    let buf = new Uint8Array(0);
    return new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        const header = new Uint8Array(FILE_HEADER_SIZE);
        header.set(FILE_MAGIC, 0);
        header.set(nonce, FILE_MAGIC_SIZE);
        controller.enqueue(header);
      },
      transform(chunk: Uint8Array, controller) {
        buf = concat(buf, chunk);
        while (buf.length >= BLOCK_DATA_SIZE) {
          const plain = buf.subarray(0, BLOCK_DATA_SIZE);
          controller.enqueue(secretboxSeal(plain, nonce, dataKey));
          incrementNonce(nonce);
          buf = buf.subarray(BLOCK_DATA_SIZE);
        }
      },
      flush(controller) {
        if (buf.length > 0) {
          controller.enqueue(secretboxSeal(buf, nonce, dataKey));
          incrementNonce(nonce);
          buf = new Uint8Array(0);
        }
      },
    });
  }

  /**
   * 解密流。输入须以 32 字节头（magic+nonce）起始。
   * startBlock：跳过前 startBlock 个块的 nonce 递增（Range 请求用，使首块使用正确的 nonce）。
   */
  makeDecryptStream(startBlock = 0): TransformStream<Uint8Array, Uint8Array> {
    const dataKey = this.dataKey;
    let buf = new Uint8Array(0);
    let headerDone = false;
    let nonce: Uint8Array | null = null;
    return new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk: Uint8Array, controller) {
        buf = concat(buf, chunk);
        if (!headerDone) {
          if (buf.length < FILE_HEADER_SIZE) return;
          for (let i = 0; i < FILE_MAGIC_SIZE; i++) {
            if (buf[i] !== FILE_MAGIC[i]) throw new Error("crypt 文件头魔数不匹配（非 rclone 加密文件或已损坏）");
          }
          nonce = buf.subarray(FILE_MAGIC_SIZE, FILE_HEADER_SIZE).slice();
          for (let i = 0; i < startBlock; i++) incrementNonce(nonce);
          buf = buf.subarray(FILE_HEADER_SIZE);
          headerDone = true;
        }
        while (buf.length >= BLOCK_SIZE) {
          const block = buf.subarray(0, BLOCK_SIZE);
          const plain = secretboxOpen(block, nonce!, dataKey);
          if (!plain) throw new Error("文件内容解密失败（密钥错误或数据损坏）");
          controller.enqueue(plain);
          incrementNonce(nonce!);
          buf = buf.subarray(BLOCK_SIZE);
        }
      },
      flush(controller) {
        if (!headerDone || buf.length === 0) return;
        const plain = secretboxOpen(buf, nonce!, dataKey);
        if (!plain) throw new Error("文件内容解密失败（密钥错误或数据损坏）");
        controller.enqueue(plain);
        incrementNonce(nonce!);
        buf = new Uint8Array(0);
      },
    });
  }

  // ---------- 文件名 ----------
  private encode(u8: Uint8Array): string {
    return this.fileNameEncoding === "base32" ? base32HexEncode(u8) : b64urlRawEncode(u8);
  }
  private decode(s: string): Uint8Array {
    return this.fileNameEncoding === "base32" ? base32HexDecode(s) : b64urlRawDecode(s);
  }

  encryptFileName(name: string): string {
    if (this.fileNameMode === "off") return name + this.suffix;
    if (this.fileNameMode === "obfuscate") {
      const bytes = enc.encode(name);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (bytes[i] + (i % 8)) & 0xff;
      return b64urlRawEncode(bytes);
    }
    const plain = pkcs7Pad(NAME_CIPHER_BLOCK_SIZE, enc.encode(name));
    const ct = transform(this.blockCipher, this.nameTweak, plain, DirectionEncrypt);
    return this.encode(ct);
  }

  decryptFileName(name: string): string {
    if (this.fileNameMode === "off") {
      if (this.suffix && name.endsWith(this.suffix)) return name.slice(0, name.length - this.suffix.length);
      return name;
    }
    if (this.fileNameMode === "obfuscate") {
      const bytes = b64urlRawDecode(name);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (bytes[i] - (i % 8)) & 0xff;
      return dec.decode(bytes);
    }
    const ct = this.decode(name);
    const plain = transform(this.blockCipher, this.nameTweak, ct, DirectionDecrypt);
    return dec.decode(pkcs7Unpad(NAME_CIPHER_BLOCK_SIZE, plain));
  }

  // 目录名加密：dirNameEncrypt=false 时直接透传明文（rclone directory_name_encryption=false）。
  encryptDirName(name: string): string {
    if (!this.dirNameEncrypt) return name;
    return this.encryptFileName(name);
  }
  decryptDirName(name: string): string {
    if (!this.dirNameEncrypt) return name;
    return this.decryptFileName(name);
  }
}

function merge(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
