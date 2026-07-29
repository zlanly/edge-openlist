// EME（ECB-Mix-ECB）宽块加密模式，移植自 github.com/rfjakob/eme（rclone crypt 使用）。
// 用于 rclone crypt 的文件名加密：Transform(bc, tweak, data, direction)。
// tweak 固定为 nameTweak（16 字节），data 为 PKCS7 填充到 16 倍数的明文。
//
// 关键特性：本实现与 rclone 的 Go 源码逐字节一致，且是自反的（self-inverting）——
// 同一段流程，只要把内部三处 AES 调用的方向（加密/解密）跟着 direction 一起切换，
// 即可同时用于加密与解密，无需单独推导逆运算。

import { AES } from "./aes";

function multByTwo(out: Uint8Array, inp: Uint8Array): void {
  if (inp.length !== 16) throw new Error("len must be 16");
  const tmp = new Uint8Array(16);
  tmp[0] = (2 * inp[0]) & 0xff;
  tmp[0] = (tmp[0] ^ (135 & (-(inp[15] >> 7)))) & 0xff;
  for (let j = 1; j < 16; j++) {
    tmp[j] = (2 * inp[j]) & 0xff;
    tmp[j] = (tmp[j] + (inp[j - 1] >> 7)) & 0xff;
  }
  out.set(tmp);
}

function xorBlocks(out: Uint8Array, in1: Uint8Array, in2: Uint8Array): void {
  for (let i = 0; i < in1.length; i++) out[i] = (in1[i] ^ in2[i]) & 0xff;
}

// 计算 L_i = 2^i * AES(K; 0)，i = 0..m-1（注意 LTable[0] = 2·E(0)）
function tabulateL(bc: AES, m: number): Uint8Array[] {
  const eZero = new Uint8Array(16);
  const Li = new Uint8Array(16);
  Li.set(bc.encryptBlock(eZero));
  const LTable: Uint8Array[] = new Array(m);
  const pool = new Uint8Array(m * 16);
  for (let i = 0; i < m; i++) {
    multByTwo(Li, Li);
    const slice = pool.subarray(i * 16, (i + 1) * 16);
    slice.set(Li);
    LTable[i] = slice;
  }
  return LTable;
}

// 方向常量
export const DirectionEncrypt = true;
export const DirectionDecrypt = false;

export function transform(
  bc: AES,
  tweak: Uint8Array,
  inputData: Uint8Array,
  direction: boolean,
): Uint8Array {
  const T = tweak;
  const P = inputData;
  if (T.length !== 16) throw new Error("Tweak must be 16 bytes long");
  if (P.length % 16 !== 0) throw new Error("Data must be a multiple of 16 long");
  const m = P.length / 16;
  if (m === 0 || m > 128) throw new Error("EME operates on 1 to 128 blocks");

  const LTable = tabulateL(bc, m);
  const C = new Uint8Array(P.length);

  // 步骤 1：PPj = Pj ⊕ L[j]; C[j] = AES(PPj, direction)
  const PPj = new Uint8Array(16);
  for (let j = 0; j < m; j++) {
    const Pj = P.subarray(j * 16, (j + 1) * 16);
    xorBlocks(PPj, Pj, LTable[j]);
    const block = direction === DirectionEncrypt
      ? bc.encryptBlock(PPj)
      : bc.decryptBlock(PPj);
    C.set(block, j * 16);
  }

  // MP = (XOR 所有 Cj) ⊕ T
  const MP = new Uint8Array(16);
  xorBlocks(MP, C.subarray(0, 16), T);
  for (let j = 1; j < m; j++) {
    xorBlocks(MP, MP, C.subarray(j * 16, (j + 1) * 16));
  }

  // MC = AES(MP, direction)
  const MC = new Uint8Array(16);
  MC.set(direction === DirectionEncrypt ? bc.encryptBlock(MP) : bc.decryptBlock(MP));

  // M = MP ⊕ MC
  const M = new Uint8Array(16);
  xorBlocks(M, MP, MC);

  // for j = 1..m-1: M = 2·M; C[j] = C[j] ⊕ M
  const CCCj = new Uint8Array(16);
  for (let j = 1; j < m; j++) {
    multByTwo(M, M);
    xorBlocks(CCCj, C.subarray(j * 16, (j + 1) * 16), M);
    C.set(CCCj, j * 16);
  }

  // CCC1 = MC ⊕ T ⊕ C[1] ⊕ ... ⊕ C[m-1]; C[0] = CCC1
  const CCC1 = new Uint8Array(16);
  xorBlocks(CCC1, MC, T);
  for (let j = 1; j < m; j++) {
    xorBlocks(CCC1, CCC1, C.subarray(j * 16, (j + 1) * 16));
  }
  C.set(CCC1, 0);

  // 末步：C[j] = AES(C[j], direction) ⊕ L[j]
  for (let j = 0; j < m; j++) {
    const block = direction === DirectionEncrypt
      ? bc.encryptBlock(C.subarray(j * 16, (j + 1) * 16))
      : bc.decryptBlock(C.subarray(j * 16, (j + 1) * 16));
    const out = new Uint8Array(16);
    xorBlocks(out, block, LTable[j]);
    C.set(out, j * 16);
  }

  return C;
}
