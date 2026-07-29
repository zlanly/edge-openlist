// 纯 TS AES（支持 128/192/256），仅提供单块（16 字节）加解密，供 EME 文件名加密使用。
// 无外部依赖。

const SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

// 逆 S 盒：由 SBOX 程序化派生，保证 INV_SBOX[SBOX[x]] === x，避免手抄错误。
const INV_SBOX = (() => {
  const inv = new Uint8Array(256);
  for (let i = 0; i < 256; i++) inv[SBOX[i]] = i;
  return inv;
})();

const RCON = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function xtime(a: number): number {
  const r = a << 1;
  return (r ^ ((r >> 8) & 1 ? 0x1b : 0)) & 0xff;
}

function gmul(a: number, b: number): number {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p & 0xff;
}

export class AES {
  private Nk: number;
  private Nr: number;
  private w: number[]; // 4*(Nr+1) words, each word = 4 bytes (big-endian int)

  constructor(key: Uint8Array) {
    const k = key.length;
    if (k !== 16 && k !== 24 && k !== 32) throw new Error("AES key must be 16/24/32 bytes");
    this.Nk = k / 4;
    this.Nr = this.Nk + 6;
    this.w = new Array(4 * (this.Nr + 1));
    // 密钥扩展
    for (let i = 0; i < this.Nk; i++) {
      this.w[i] = (key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3];
    }
    for (let i = this.Nk; i < 4 * (this.Nr + 1); i++) {
      let temp = this.w[i - 1];
      if (i % this.Nk === 0) {
        temp = this.subWord(this.rotWord(temp)) ^ (RCON[i / this.Nk] << 24);
      } else if (this.Nk > 6 && i % this.Nk === 4) {
        temp = this.subWord(temp);
      }
      this.w[i] = (this.w[i - this.Nk] ^ temp) | 0;
    }
  }

  private subWord(x: number): number {
    return (
      (SBOX[x >>> 24] << 24) | (SBOX[(x >>> 16) & 0xff] << 16) | (SBOX[(x >>> 8) & 0xff] << 8) | SBOX[x & 0xff]
    );
  }
  private rotWord(x: number): number {
    return ((x << 8) | (x >>> 24)) | 0;
  }

  // 单块加解密（state 为 16 字节，原地修改由调用方处理）
  private addRoundKey(state: Uint8Array, round: number): void {
    for (let c = 0; c < 4; c++) {
      const word = this.w[round * 4 + c];
      state[c * 4] ^= (word >>> 24) & 0xff;
      state[c * 4 + 1] ^= (word >>> 16) & 0xff;
      state[c * 4 + 2] ^= (word >>> 8) & 0xff;
      state[c * 4 + 3] ^= word & 0xff;
    }
  }

  encryptBlock(input: Uint8Array): Uint8Array {
    const s = input.slice(0, 16);
    this.addRoundKey(s, 0);
    for (let r = 1; r < this.Nr; r++) {
      // SubBytes + ShiftRows
      const t = new Uint8Array(16);
      for (let i = 0; i < 16; i++) t[i] = SBOX[s[i]];
      // ShiftRows: row r shifted left by r
      const sr = new Uint8Array(16);
      const shifts = [0, 1, 2, 3];
      for (let c = 0; c < 4; c++) {
        for (let rrow = 0; rrow < 4; rrow++) {
          sr[rrow * 4 + c] = t[((rrow + shifts[c]) % 4) * 4 + c];
        }
      }
      // MixColumns
      for (let c = 0; c < 4; c++) {
        const a0 = sr[c * 4], a1 = sr[c * 4 + 1], a2 = sr[c * 4 + 2], a3 = sr[c * 4 + 3];
        s[c * 4] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
        s[c * 4 + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
        s[c * 4 + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
        s[c * 4 + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
      }
      this.addRoundKey(s, r);
    }
    // 最后一轮：SubBytes + ShiftRows + AddRoundKey（无 MixColumns）
    const t = new Uint8Array(16);
    for (let i = 0; i < 16; i++) t[i] = SBOX[s[i]];
    const sr = new Uint8Array(16);
    const shifts = [0, 1, 2, 3];
    for (let c = 0; c < 4; c++) {
      for (let rrow = 0; rrow < 4; rrow++) {
        sr[rrow * 4 + c] = t[((rrow + shifts[c]) % 4) * 4 + c];
      }
    }
    this.addRoundKey(sr, this.Nr);
    return sr;
  }

  decryptBlock(input: Uint8Array): Uint8Array {
    const s = input.slice(0, 16);
    // 解密 = 加密的精确逆。加密轮：SubBytes -> ShiftRows -> MixColumns -> AddRoundKey(r)。
    // 末轮（无 MixColumns）：SubBytes -> ShiftRows -> AddRoundKey(Nr)。
    const addRoundKey = (st: Uint8Array, round: number) => {
      for (let c = 0; c < 4; c++) {
        const word = this.w[round * 4 + c];
        st[c * 4] ^= (word >>> 24) & 0xff;
        st[c * 4 + 1] ^= (word >>> 16) & 0xff;
        st[c * 4 + 2] ^= (word >>> 8) & 0xff;
        st[c * 4 + 3] ^= word & 0xff;
      }
    };
    const invShiftRows = (st: Uint8Array): Uint8Array => {
      const out = new Uint8Array(16);
      for (let c = 0; c < 4; c++)
        for (let rrow = 0; rrow < 4; rrow++)
          out[rrow * 4 + c] = st[(((rrow - c) % 4) + 4) % 4 * 4 + c];
      return out;
    };
    const invSubBytes = (st: Uint8Array): Uint8Array => {
      const out = new Uint8Array(16);
      for (let i = 0; i < 16; i++) out[i] = INV_SBOX[st[i]];
      return out;
    };
    const invMixColumns = (st: Uint8Array): Uint8Array => {
      const out = new Uint8Array(16);
      for (let c = 0; c < 4; c++) {
        const a0 = st[c * 4], a1 = st[c * 4 + 1], a2 = st[c * 4 + 2], a3 = st[c * 4 + 3];
        out[c * 4] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
        out[c * 4 + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
        out[c * 4 + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
        out[c * 4 + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
      }
      return out;
    };

    // 撤销末轮加密（无 MixColumns）：AddRoundKey(Nr) -> InvShiftRows -> InvSubBytes
    addRoundKey(s, this.Nr);
    s.set(invShiftRows(s));
    s.set(invSubBytes(s));
    // 逆向中间轮：AddRoundKey(r) -> InvMixColumns -> InvShiftRows -> InvSubBytes
    for (let r = this.Nr - 1; r > 0; r--) {
      addRoundKey(s, r);
      s.set(invMixColumns(s));
      s.set(invShiftRows(s));
      s.set(invSubBytes(s));
    }
    // 末步 AddRoundKey(0)
    addRoundKey(s, 0);
    return s;
  }
}
