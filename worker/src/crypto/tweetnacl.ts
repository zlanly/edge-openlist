// 从 TweetNaCl (Public Domain, dchest/tweetnacl-js) 移植的 NaCl secretbox 底层原语。
// 仅保留 rclone crypt 需要的：Salsa20 / HSalsa20 / XSalsa20 keystream 与 Poly1305。
// 算术与原始实现逐位一致，确保在 Cloudflare Worker 上无需任何外部依赖即可运行。

function L32(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

function ld32(x: Uint8Array, i: number): number {
  let u = x[i + 3] & 0xff;
  u = (u << 8) | (x[i + 2] & 0xff);
  u = (u << 8) | (x[i + 1] & 0xff);
  return (u << 8) | (x[i + 0] & 0xff);
}

function st32(x: Uint8Array, j: number, u: number): void {
  for (let i = 0; i < 4; i++) {
    x[j + i] = u & 255;
    u >>>= 8;
  }
}

function vn(x: Uint8Array, xi: number, y: Uint8Array, yi: number, n: number): number {
  let d = 0;
  for (let i = 0; i < n; i++) d |= x[xi + i] ^ y[yi + i];
  return (1 & ((d - 1) >>> 8)) - 1;
}

export function crypto_verify_16(x: Uint8Array, xi: number, y: Uint8Array, yi: number): number {
  return vn(x, xi, y, yi, 16);
}

// Salsa20 / HSalsa20 核心。rounds 传入 20（Salsa20 完整 20 轮）或 8（scrypt 的 blockMix 用 Salsa20/8）。
// 采用与 dchest/tweetnacl-js（nacl-fast）逐位一致的全展开实现：先按 NaCl 状态布局填充 x0..x15，
// 随后每个 r+=2 步执行一次“列轮 + 行/对角轮”（共 8 个 quarter round），最后累加初始状态。
function core(
  out: Uint8Array,
  inp: Uint8Array,
  k: Uint8Array,
  c: Uint8Array,
  h: boolean,
  rounds: number,
): void {
  const j0 = c[0] & 0xff | (c[1] & 0xff) << 8 | (c[2] & 0xff) << 16 | (c[3] & 0xff) << 24;
  const j1 = k[0] & 0xff | (k[1] & 0xff) << 8 | (k[2] & 0xff) << 16 | (k[3] & 0xff) << 24;
  const j2 = k[4] & 0xff | (k[5] & 0xff) << 8 | (k[6] & 0xff) << 16 | (k[7] & 0xff) << 24;
  const j3 = k[8] & 0xff | (k[9] & 0xff) << 8 | (k[10] & 0xff) << 16 | (k[11] & 0xff) << 24;
  const j4 = k[12] & 0xff | (k[13] & 0xff) << 8 | (k[14] & 0xff) << 16 | (k[15] & 0xff) << 24;
  const j5 = c[4] & 0xff | (c[5] & 0xff) << 8 | (c[6] & 0xff) << 16 | (c[7] & 0xff) << 24;
  const j6 = inp[0] & 0xff | (inp[1] & 0xff) << 8 | (inp[2] & 0xff) << 16 | (inp[3] & 0xff) << 24;
  const j7 = inp[4] & 0xff | (inp[5] & 0xff) << 8 | (inp[6] & 0xff) << 16 | (inp[7] & 0xff) << 24;
  const j8 = inp[8] & 0xff | (inp[9] & 0xff) << 8 | (inp[10] & 0xff) << 16 | (inp[11] & 0xff) << 24;
  const j9 = inp[12] & 0xff | (inp[13] & 0xff) << 8 | (inp[14] & 0xff) << 16 | (inp[15] & 0xff) << 24;
  const j10 = c[8] & 0xff | (c[9] & 0xff) << 8 | (c[10] & 0xff) << 16 | (c[11] & 0xff) << 24;
  const j11 = k[16] & 0xff | (k[17] & 0xff) << 8 | (k[18] & 0xff) << 16 | (k[19] & 0xff) << 24;
  const j12 = k[20] & 0xff | (k[21] & 0xff) << 8 | (k[22] & 0xff) << 16 | (k[23] & 0xff) << 24;
  const j13 = k[24] & 0xff | (k[25] & 0xff) << 8 | (k[26] & 0xff) << 16 | (k[27] & 0xff) << 24;
  const j14 = k[28] & 0xff | (k[29] & 0xff) << 8 | (k[30] & 0xff) << 16 | (k[31] & 0xff) << 24;
  const j15 = c[12] & 0xff | (c[13] & 0xff) << 8 | (c[14] & 0xff) << 16 | (c[15] & 0xff) << 24;

  let x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5;
  let x6 = j6, x7 = j7, x8 = j8, x9 = j9, x10 = j10, x11 = j11;
  let x12 = j12, x13 = j13, x14 = j14, x15 = j15, u: number;

  for (let r = 0; r < rounds; r += 2) {
    // column rounds
    u = (x0 + x12) | 0; x4 ^= L32(u, 7);
    u = (x4 + x0) | 0; x8 ^= L32(u, 9);
    u = (x8 + x4) | 0; x12 ^= L32(u, 13);
    u = (x12 + x8) | 0; x0 ^= L32(u, 18);

    u = (x5 + x1) | 0; x9 ^= L32(u, 7);
    u = (x9 + x5) | 0; x13 ^= L32(u, 9);
    u = (x13 + x9) | 0; x1 ^= L32(u, 13);
    u = (x1 + x13) | 0; x5 ^= L32(u, 18);

    u = (x10 + x6) | 0; x14 ^= L32(u, 7);
    u = (x14 + x10) | 0; x2 ^= L32(u, 9);
    u = (x2 + x14) | 0; x6 ^= L32(u, 13);
    u = (x6 + x2) | 0; x10 ^= L32(u, 18);

    u = (x15 + x11) | 0; x3 ^= L32(u, 7);
    u = (x3 + x15) | 0; x7 ^= L32(u, 9);
    u = (x7 + x3) | 0; x11 ^= L32(u, 13);
    u = (x11 + x7) | 0; x15 ^= L32(u, 18);

    // row / diagonal rounds
    u = (x0 + x3) | 0; x1 ^= L32(u, 7);
    u = (x1 + x0) | 0; x2 ^= L32(u, 9);
    u = (x2 + x1) | 0; x3 ^= L32(u, 13);
    u = (x3 + x2) | 0; x0 ^= L32(u, 18);

    u = (x5 + x4) | 0; x6 ^= L32(u, 7);
    u = (x6 + x5) | 0; x7 ^= L32(u, 9);
    u = (x7 + x6) | 0; x4 ^= L32(u, 13);
    u = (x4 + x7) | 0; x5 ^= L32(u, 18);

    u = (x10 + x9) | 0; x11 ^= L32(u, 7);
    u = (x11 + x10) | 0; x8 ^= L32(u, 9);
    u = (x8 + x11) | 0; x9 ^= L32(u, 13);
    u = (x9 + x8) | 0; x10 ^= L32(u, 18);

    u = (x15 + x14) | 0; x12 ^= L32(u, 7);
    u = (x12 + x15) | 0; x13 ^= L32(u, 9);
    u = (x13 + x12) | 0; x14 ^= L32(u, 13);
    u = (x14 + x13) | 0; x15 ^= L32(u, 18);
  }

  if (h) {
    // HSalsa20：不回加初始状态（与 nacl-fast 一致），直接输出派生 subkey = x0,x5,x10,x15,x6,x7,x8,x9。
    st32(out, 0, x0); st32(out, 4, x5); st32(out, 8, x10); st32(out, 12, x15);
    st32(out, 16, x6); st32(out, 20, x7); st32(out, 24, x8); st32(out, 28, x9);
  } else {
    // Salsa20：回加初始状态后输出全部 16 字。
    x0 = (x0 + j0) | 0; x1 = (x1 + j1) | 0; x2 = (x2 + j2) | 0; x3 = (x3 + j3) | 0;
    x4 = (x4 + j4) | 0; x5 = (x5 + j5) | 0; x6 = (x6 + j6) | 0; x7 = (x7 + j7) | 0;
    x8 = (x8 + j8) | 0; x9 = (x9 + j9) | 0; x10 = (x10 + j10) | 0; x11 = (x11 + j11) | 0;
    x12 = (x12 + j12) | 0; x13 = (x13 + j13) | 0; x14 = (x14 + j14) | 0; x15 = (x15 + j15) | 0;
    st32(out, 0, x0); st32(out, 4, x1); st32(out, 8, x2); st32(out, 12, x3);
    st32(out, 16, x4); st32(out, 20, x5); st32(out, 24, x6); st32(out, 28, x7);
    st32(out, 32, x8); st32(out, 36, x9); st32(out, 40, x10); st32(out, 44, x11);
    st32(out, 48, x12); st32(out, 52, x13); st32(out, 56, x14); st32(out, 60, x15);
  }
}

export function crypto_core_salsa20(out: Uint8Array, inp: Uint8Array, k: Uint8Array, c: Uint8Array): void {
  core(out, inp, k, c, false, 20);
}

export function crypto_core_hsalsa20(out: Uint8Array, inp: Uint8Array, k: Uint8Array, c: Uint8Array): void {
  core(out, inp, k, c, true, 20);
}

// 供 scrypt 使用的 Salsa20/8（8 轮）。
export function crypto_core_salsa20_8(out: Uint8Array, inp: Uint8Array, k: Uint8Array, c: Uint8Array): void {
  core(out, inp, k, c, false, 8);
}

export const sigma = new Uint8Array([
  101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107,
]); // "expand 32-byte k"

function crypto_stream_salsa20_xor(
  c: Uint8Array,
  cpos: number,
  m: Uint8Array | null,
  mpos: number,
  b: number,
  n: Uint8Array,
  k: Uint8Array,
): void {
  const z = new Uint8Array(16);
  const x = new Uint8Array(64);
  let u: number, i: number;
  if (!b) return;
  for (i = 0; i < 16; i++) z[i] = 0;
  for (i = 0; i < 8; i++) z[i] = n[i];
  while (b >= 64) {
    crypto_core_salsa20(x, z, k, sigma);
    for (i = 0; i < 64; i++) c[cpos + i] = ((m ? m[mpos + i] : 0) ^ x[i]) & 0xff;
    u = 1;
    for (i = 8; i < 16; i++) {
      u = (u + (z[i] & 0xff)) | 0;
      z[i] = u & 0xff;
      u >>>= 8;
    }
    b -= 64;
    cpos += 64;
    if (m) mpos += 64;
  }
  if (b > 0) {
    crypto_core_salsa20(x, z, k, sigma);
    for (i = 0; i < b; i++) c[cpos + i] = ((m ? m[mpos + i] : 0) ^ x[i]) & 0xff;
  }
}

// XSalsa20：先用 HSalsa20 把 24 字节 nonce 的前 16 字节与 key 派生出 subkey，
// 再用 Salsa20 以 nonce 的后 8 字节（补 8 字节 0）生成 keystream。
export function crypto_stream(c: Uint8Array, cpos: number, d: number, n: Uint8Array, k: Uint8Array): void {
  const s = new Uint8Array(32);
  crypto_core_hsalsa20(s, n, k, sigma);
  crypto_stream_salsa20_xor(c, cpos, null, 0, d, n.subarray(16), s);
}

function add1305(h: Uint32Array, c: Uint32Array): void {
  let j: number, u = 0;
  for (j = 0; j < 17; j++) {
    u = (u + (h[j] + c[j])) | 0;
    h[j] = u & 255;
    u >>>= 8;
  }
}

const minusp = new Uint32Array([5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 252]);

export function crypto_onetimeauth(
  out: Uint8Array,
  outpos: number,
  m: Uint8Array,
  mpos: number,
  n: number,
  k: Uint8Array,
): void {
  const x = new Uint32Array(17);
  const r = new Uint32Array(17);
  const h = new Uint32Array(17);
  const c = new Uint32Array(17);
  const g = new Uint32Array(17);
  let j: number, i: number, u: number;
  for (j = 0; j < 17; j++) r[j] = h[j] = 0;
  for (j = 0; j < 16; j++) r[j] = k[j];
  r[3] &= 15;
  r[4] &= 252;
  r[7] &= 15;
  r[8] &= 252;
  r[11] &= 15;
  r[12] &= 252;
  r[15] &= 15;

  while (n > 0) {
    for (j = 0; j < 17; j++) c[j] = 0;
    for (j = 0; j < 16 && j < n; ++j) c[j] = m[mpos + j];
    c[j] = 1;
    mpos += j;
    n -= j;
    add1305(h, c);
    for (i = 0; i < 17; i++) {
      x[i] = 0;
      for (j = 0; j < 17; j++)
        x[i] = (x[i] + h[j] * (j <= i ? r[i - j] : 320 * r[i + 17 - j])) | 0;
    }
    for (i = 0; i < 17; i++) h[i] = x[i];
    u = 0;
    for (j = 0; j < 16; j++) {
      u = (u + h[j]) | 0;
      h[j] = u & 255;
      u >>>= 8;
    }
    u = (u + h[16]) | 0;
    h[16] = u & 3;
    u = (5 * (u >>> 2)) | 0;
    for (j = 0; j < 16; j++) {
      u = (u + h[j]) | 0;
      h[j] = u & 255;
      u >>>= 8;
    }
    u = (u + h[16]) | 0;
    h[16] = u;
  }

  for (j = 0; j < 17; j++) g[j] = h[j];
  add1305(h, minusp);
  u = -(h[16] >>> 7) | 0;
  for (j = 0; j < 17; j++) h[j] ^= u & (g[j] ^ h[j]);

  for (j = 0; j < 16; j++) c[j] = k[j + 16];
  c[16] = 0;
  add1305(h, c);
  for (j = 0; j < 16; j++) out[outpos + j] = h[j];
}

export function crypto_onetimeauth_verify(
  h: Uint8Array,
  hpos: number,
  m: Uint8Array,
  mpos: number,
  n: number,
  k: Uint8Array,
): number {
  const x = new Uint8Array(16);
  crypto_onetimeauth(x, 0, m, mpos, n, k);
  return crypto_verify_16(h, hpos, x, 0);
}

// 生成 XSalsa20 keystream（长度 len，24 字节 nonce，32 字节 key）。
export function xsalsa20Keystream(len: number, nonce: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(len);
  crypto_stream(out, 0, len, nonce, key);
  return out;
}

// NaCl secretbox（与 Go 的 nacl/secretbox 完全一致的 Seal/Open）：
// box = Poly1305(keystream[0:32], ct) || ct，ct = msg XOR keystream[32:]。
export function secretboxSeal(msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array {
  const ks = xsalsa20Keystream(32 + msg.length, nonce, key);
  const polyKey = ks.subarray(0, 32);
  const ct = new Uint8Array(msg.length);
  for (let i = 0; i < msg.length; i++) ct[i] = (msg[i] ^ ks[32 + i]) & 0xff;
  const mac = new Uint8Array(16);
  crypto_onetimeauth(mac, 0, ct, 0, ct.length, polyKey);
  const out = new Uint8Array(16 + ct.length);
  out.set(mac, 0);
  out.set(ct, 16);
  return out;
}

export function secretboxOpen(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null {
  if (box.length < 16) return null;
  const ctLen = box.length - 16;
  const ks = xsalsa20Keystream(32 + ctLen, nonce, key);
  const polyKey = ks.subarray(0, 32);
  const mac = box.subarray(0, 16);
  const ct = box.subarray(16);
  const computed = new Uint8Array(16);
  crypto_onetimeauth(computed, 0, ct, 0, ct.length, polyKey);
  if (crypto_verify_16(mac, 0, computed, 0) !== 0) return null;
  const msg = new Uint8Array(ctLen);
  for (let i = 0; i < ctLen; i++) msg[i] = (ct[i] ^ ks[32 + i]) & 0xff;
  return msg;
}
