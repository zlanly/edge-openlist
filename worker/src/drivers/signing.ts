// 共享签名/哈希辅助（WebCrypto 实现，兼容 CF Worker）
export function bufToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function importHmac(key: ArrayBuffer | Uint8Array | string): Promise<CryptoKey> {
  const k = typeof key === "string" ? new TextEncoder().encode(key) : key;
  return crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function sha256Hex(data: ArrayBuffer | string | Uint8Array): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return bufToHex(await crypto.subtle.digest("SHA-256", buf));
}

export async function sha1Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  return bufToHex(await crypto.subtle.digest("SHA-1", data));
}

export async function hmacSha256(key: ArrayBuffer | Uint8Array | string, data: string | ArrayBuffer): Promise<ArrayBuffer> {
  const ck = await importHmac(key);
  const d = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return crypto.subtle.sign("HMAC", ck, d);
}

export async function hmacSha256Hex(key: ArrayBuffer | Uint8Array | string, data: string | ArrayBuffer): Promise<string> {
  return bufToHex(await hmacSha256(key, data));
}

export function b64url(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
