import { createRequire } from "module";
const require = createRequire(import.meta.url);
const nacl = require("/tmp/nacl-fast.js");

function hex(u8: Uint8Array): string {
  return Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

const sigma = new Uint8Array([101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107]);

// HSalsa20 标准向量：key=00..1f, nonce=16*0 + 00 00 00 00 4a 00 00 00
{
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = i;
  const nonce = new Uint8Array(24);
  nonce[20] = 0x4a;
  const out = new Uint8Array(32);
  nacl.lowlevel.crypto_core_hsalsa20(out, nonce, key, sigma);
  console.log("REF HSalsa20     :", hex(out));
}

// secretbox with zero key, nonce=01..18, plaintext=0x01
{
  const key = new Uint8Array(32);
  const nonce = new Uint8Array(24);
  for (let i = 0; i < 24; i++) nonce[i] = i + 1;
  const ct = nacl.secretbox(new Uint8Array([0x01]), nonce, key);
  console.log("REF secretbox    :", hex(ct));
  console.log("WANT file1 block : 09 5b 44 6c d6 23 7b bc b0 8d 09 fb 52 4c e5 65 aa");
  const pt = nacl.secretbox.open(ct, nonce, key);
  console.log("REF open         :", pt ? hex(pt) : "FAIL");
}
