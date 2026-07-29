// 纯 JS MD5（WebCrypto 不提供 MD5）。供 netease_music / ilanzou / 123 / quark 上传校验使用。
// 同时提供 SHA1（基于 crypto.subtle）与接受 string 的重载，便于各驱动复用。
function toBytes(input: Uint8Array | string): Uint8Array {
  if (typeof input === "string") return new TextEncoder().encode(input);
  return input;
}

export function md5(bytes: Uint8Array | string): Uint8Array {
  const data = toBytes(bytes);
  function rotl(x: number, c: number): number { return (x << c) | (x >>> (32 - c)); }
  function add32(a: number, b: number): number { return (a + b) & 0xffffffff; }
  const s = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = new Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) & 0xffffffff;
  const origLen = data.length;
  const bitLen = origLen * 8;
  const withPad = origLen + 1;
  const total = ((withPad + 8 + 63) & ~63);
  const msg = new Uint8Array(total);
  msg.set(data);
  msg[origLen] = 0x80;
  // 64-bit little-endian length at end
  const dv = new DataView(msg.buffer);
  dv.setUint32(total - 8, bitLen >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bitLen / 4294967296) >>> 0, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  const M = new Int32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = add32(add32(F, A), add32(K[i], M[g]));
      A = D; D = C; C = B; B = add32(B, rotl(F, s[i]));
    }
    a0 = add32(a0, A); b0 = add32(b0, B); c0 = add32(c0, C); d0 = add32(d0, D);
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true); ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return out;
}

export function md5Hex(bytes: Uint8Array | string): string {
  return Array.from(md5(bytes)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha1Hex(bytes: Uint8Array | string): Promise<string> {
  const data = toBytes(bytes);
  const buf = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
