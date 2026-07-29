// 纯 TS scrypt（RFC 7914），移植自 ricmoo/scrypt-js（生产级参考实现）。
// 用于 rclone crypt 的密钥派生：scrypt(password, salt, N=16384, r=8, p=1, 80)。
// PBKDF2/SHA256 复用本仓库的 sha256.ts。

import { sha256 } from "./sha256";

function R(a: number, b: number): number {
  return (a << b) | (a >>> (32 - b));
}

function blockxor(S: Uint32Array, Si: number, D: Uint32Array, len: number): void {
  for (let i = 0; i < len; i++) D[i] ^= S[Si + i];
}

function arraycopy(src: Uint32Array, srcPos: number, dest: Uint32Array, destPos: number, length: number): void {
  for (let i = 0; i < length; i++) dest[destPos + i] = src[srcPos + i];
}

// Salsa20/8：B 为 16 个字（64 字节）的输入/输出；x 为 16 字临时状态。
function salsa20_8(B: Uint32Array, x: Uint32Array): void {
  for (let i = 0; i < 16; i++) x[i] = B[i];
  for (let i = 8; i > 0; i -= 2) {
    x[4] ^= R(x[0] + x[12], 7);
    x[8] ^= R(x[4] + x[0], 9);
    x[12] ^= R(x[8] + x[4], 13);
    x[0] ^= R(x[12] + x[8], 18);
    x[9] ^= R(x[5] + x[1], 7);
    x[13] ^= R(x[9] + x[5], 9);
    x[1] ^= R(x[13] + x[9], 13);
    x[5] ^= R(x[1] + x[13], 18);
    x[14] ^= R(x[10] + x[6], 7);
    x[2] ^= R(x[14] + x[10], 9);
    x[6] ^= R(x[2] + x[14], 13);
    x[10] ^= R(x[6] + x[2], 18);
    x[3] ^= R(x[15] + x[11], 7);
    x[7] ^= R(x[3] + x[15], 9);
    x[11] ^= R(x[7] + x[3], 13);
    x[15] ^= R(x[11] + x[7], 18);
    x[1] ^= R(x[0] + x[3], 7);
    x[2] ^= R(x[1] + x[0], 9);
    x[3] ^= R(x[2] + x[1], 13);
    x[0] ^= R(x[3] + x[2], 18);
    x[6] ^= R(x[5] + x[4], 7);
    x[7] ^= R(x[6] + x[5], 9);
    x[4] ^= R(x[7] + x[6], 13);
    x[5] ^= R(x[4] + x[7], 18);
    x[11] ^= R(x[10] + x[9], 7);
    x[8] ^= R(x[11] + x[10], 9);
    x[9] ^= R(x[8] + x[11], 13);
    x[10] ^= R(x[9] + x[8], 18);
    x[12] ^= R(x[15] + x[14], 7);
    x[13] ^= R(x[12] + x[15], 9);
    x[14] ^= R(x[13] + x[12], 13);
    x[15] ^= R(x[14] + x[13], 18);
  }
  for (let i = 0; i < 16; ++i) B[i] = (B[i] + x[i]) | 0;
}

function blockmix_salsa8(BY: Uint32Array, Yi: number, r: number, x: Uint32Array, _X: Uint32Array): void {
  const last = (2 * r - 1) * 16;
  for (let i = 0; i < 16; i++) _X[i] = BY[last + i];
  for (let i = 0; i < 2 * r; i++) {
    blockxor(BY, i * 16, _X, 16);
    salsa20_8(_X, x);
    arraycopy(_X, 0, BY, Yi + i * 16, 16);
  }
  for (let i = 0; i < r; i++) arraycopy(BY, Yi + i * 2 * 16, BY, i * 16, 16);
  for (let i = 0; i < r; i++) arraycopy(BY, Yi + (i * 2 + 1) * 16, BY, (i + r) * 16, 16);
}

// PBKDF2-HMAC-SHA256，单轮（c=1）。返回 dkLen 字节。
function pbkdf2OneIter(password: Uint8Array, salt: Uint8Array, dkLen: number): Uint8Array {
  let key = password;
  if (key.length > 64) key = sha256(key);
  const inner = new Uint8Array(64 + salt.length + 4);
  for (let i = 0; i < 64; i++) inner[i] = 0x36 ^ (i < key.length ? key[i] : 0);
  inner.set(salt, 64);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) outer[i] = 0x5c ^ (i < key.length ? key[i] : 0);
  const out = new Uint8Array(dkLen);
  let produced = 0;
  let counter = 1;
  while (produced < dkLen) {
    inner[inner.length - 4] = (counter >>> 24) & 0xff;
    inner[inner.length - 3] = (counter >>> 16) & 0xff;
    inner[inner.length - 2] = (counter >>> 8) & 0xff;
    inner[inner.length - 1] = counter & 0xff;
    const innerHash = sha256(inner);
    outer.set(innerHash, 64);
    const block = sha256(outer);
    const take = Math.min(32, dkLen - produced);
    out.set(block.subarray(0, take), produced);
    produced += take;
    counter++;
  }
  return out;
}

// scrypt(P, S, N, r, p, dkLen)。rclone crypt 调用：scrypt(pw, salt, 16384, 8, 1, 80)。
export function scrypt(
  password: Uint8Array,
  salt: Uint8Array,
  N: number,
  r: number,
  p: number,
  dkLen: number,
): Uint8Array {
  const b = pbkdf2OneIter(password, salt, p * 128 * r);
  const B = new Uint32Array(p * 32 * r);
  for (let i = 0; i < B.length; i++) {
    const j = i * 4;
    B[i] =
      ((b[j + 3] & 0xff) << 24) | ((b[j + 2] & 0xff) << 16) | ((b[j + 1] & 0xff) << 8) | (b[j] & 0xff);
  }
  const XY = new Uint32Array(64 * r);
  const V = new Uint32Array(32 * r * N);
  const Yi = 32 * r;
  const x = new Uint32Array(16);
  const _X = new Uint32Array(16);

  for (let i0 = 0; i0 < p; i0++) {
    const Bi = i0 * 32 * r;
    for (let i = 0; i < Yi; i++) XY[i] = B[Bi + i];
    // ROMix 第一遍：构建 V
    for (let i1 = 0; i1 < N; i1++) {
      for (let i = 0; i < Yi; i++) V[i1 * Yi + i] = XY[i];
      blockmix_salsa8(XY, Yi, r, x, _X);
    }
    // ROMix 第二遍：混合并 XOR V[j]
    for (let i1 = 0; i1 < N; i1++) {
      const offset = (2 * r - 1) * 16;
      const j = XY[offset] & (N - 1);
      blockxor(V, j * Yi, XY, Yi);
      blockmix_salsa8(XY, Yi, r, x, _X);
    }
    for (let i = 0; i < Yi; i++) B[Bi + i] = XY[i];
  }

  const out = new Uint8Array(B.length * 4);
  for (let i = 0; i < B.length; i++) {
    out[i * 4] = B[i] & 0xff;
    out[i * 4 + 1] = (B[i] >>> 8) & 0xff;
    out[i * 4 + 2] = (B[i] >>> 16) & 0xff;
    out[i * 4 + 3] = (B[i] >>> 24) & 0xff;
  }
  return pbkdf2OneIter(password, out, dkLen);
}
