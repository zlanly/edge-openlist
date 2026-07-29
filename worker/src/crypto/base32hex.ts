// RFC4648 base32（hex 字母表 0-9A-V），小写无填充编码，与 rclone 的 caseInsensitiveBase32Encoding 一致。
// 编码：base32hex(input) → 小写、去 '=' 填充。
// 解码：大写下、补 '=' 填充、base32hex 解码。

const ALPHABET = "0123456789abcdefghijklmnopqrstuv"; // 编解码统一用小写表，编码后整体转小写

function encodeChunk(buf: Uint8Array): string {
  // 5 字节 → 8 字符
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32HexEncode(src: Uint8Array): string {
  const raw = encodeChunk(src);
  // 去掉填充并小写（ALPHABET 已为小写）
  return raw.replace(/=+$/, "").toLowerCase();
}

export function base32HexDecode(s: string): Uint8Array {
  if (s.endsWith("=")) throw new Error("bad base32 encoding");
  let up = s.toUpperCase();
  // 补齐到 8 的倍数
  const pad = (8 - (up.length % 8)) % 8;
  up = up + "=".repeat(pad);
  // 反转表
  const rev: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) rev[ALPHABET[i].toUpperCase()] = i;
  // 解析成比特再按 8 位分组
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (let i = 0; i < up.length; i++) {
    const ch = up[i];
    if (ch === "=") continue;
    const v = rev[ch];
    if (v === undefined) throw new Error("bad base32 char: " + ch);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
