// 纯 WebCrypto 实现的 AES 辅助（WebCrypto 不支持 ECB，故 ECB 以每 16 字节块独立 CBC+零IV 模拟）。
// 供 netease_music / ilanzou 等驱动使用。

function keyPending(key: Uint8Array): Uint8Array {
  const k = key.length;
  let n = 0;
  if (k <= 16) n = 16;
  else if (k <= 24) n = 24;
  else if (k <= 32) n = 32;
  if (n === 0) return key.slice(0, 32);
  if (n === k) return key;
  const out = new Uint8Array(n);
  out.set(key);
  return out;
}

async function importAes(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", keyPending(key), { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
}

function pkcs7Pad(data: Uint8Array, block = 16): Uint8Array {
  const pad = block - (data.length % block);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}

export async function aesCbcEncrypt(plain: Uint8Array, key: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  const ck = await importAes(key);
  const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, ck, pkcs7Pad(plain));
  return new Uint8Array(ct);
}

export async function aesCbcDecrypt(cipher: Uint8Array, key: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  const ck = await importAes(key);
  const pt = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, ck, cipher);
  return new Uint8Array(pt);
}

// ECB：逐 16 字节块以零 IV 的 CBC 加密（等价 ECB）
export async function aesEcbEncrypt(plain: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const ck = await importAes(key);
  const zero = new Uint8Array(16);
  const padded = pkcs7Pad(plain);
  const out = new Uint8Array(padded.length);
  for (let i = 0; i < padded.length; i += 16) {
    const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv: zero }, ck, padded.slice(i, i + 16));
    out.set(new Uint8Array(ct), i);
  }
  return out;
}

export function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export function bytesToString(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}
export function stringToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
