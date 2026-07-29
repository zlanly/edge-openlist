// rclone 配置密码混淆（obscure）的解码（Reveal）。
// 用于接受 rclone.conf 中的 password / password2 字段（AES-CTR + 固定密钥 + base64url）。
// 参考 github.com/rclone/rclone/fs/config/obscure。

import { AES } from "./aes";

const CRYPT_KEY = new Uint8Array([
  0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d, 0x6b, 0xfd, 0x7c, 0x63, 0xc8, 0x86, 0xa9, 0x2b,
  0xd3, 0x90, 0x19, 0x8e, 0xb8, 0x12, 0x8a, 0xfb, 0xf4, 0xde, 0x16, 0x2b, 0x8b, 0x95, 0xf6, 0x38,
]);

// 大端递增 16 字节计数器
function incrementCounter(counter: Uint8Array): void {
  for (let i = 15; i >= 0; i--) {
    if (counter[i] === 0xff) {
      counter[i] = 0;
    } else {
      counter[i]++;
      break;
    }
  }
}

// 解码 rclone 混淆后的密码字符串。若不是合法混淆串（如无 '=' 填充问题的原始串），原样返回。
export function reveal(x: string): string {
  let ct: Uint8Array;
  try {
    ct = base64UrlDecode(x);
  } catch {
    // 不是 base64url 串 → 当作原始密码直接返回
    return x;
  }
  if (ct.length < 16) return x;
  const iv = ct.subarray(0, 16);
  const data = ct.subarray(16);
  const bc = new AES(CRYPT_KEY);
  const counter = iv.slice(0, 16);
  const out = new Uint8Array(data.length);
  let pos = 0;
  while (pos < data.length) {
    const ks = bc.encryptBlock(counter);
    const n = Math.min(16, data.length - pos);
    for (let i = 0; i < n; i++) out[pos + i] = (data[pos + i] ^ ks[i]) & 0xff;
    incrementCounter(counter);
    pos += n;
  }
  // 去掉尾随的 0？rclone 的明文长度恰好 = data.length（CTR 不改变长度），直接按字节转字符串
  return new TextDecoder().decode(out);
}

function base64UrlDecode(s: string): Uint8Array {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
