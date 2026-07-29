import {
  crypto_core_salsa20,
  crypto_core_salsa20_8,
  crypto_core_hsalsa20,
  secretboxSeal,
  secretboxOpen,
  xsalsa20Keystream,
  sigma,
} from "../worker/src/crypto/tweetnacl";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const nacl = require("/tmp/nacl-fast.js");

function hex(u8: Uint8Array): string {
  return Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

// 1) Salsa20/20 标准向量：key=00..1f, in=zeros(16), c=sigma
{
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = i;
  const inp = new Uint8Array(16);
  const out = new Uint8Array(64);
  crypto_core_salsa20(out, inp, key, sigma);
  console.log("Salsa20/20 keystream[0:16]:", hex(out.subarray(0, 16)));
  const want = "4a 03 02 0e 4b 0a 5c 0c 6f 81 2c 14 ac 74 19 9d";
  console.log("WANT                       :", want);
  console.log("MATCH:", hex(out.subarray(0, 16)) === want);
  console.log("full64:", hex(out));
}

// 2) Salsa20/8 标准向量（BlockMix 用）：key=00..1f, in=zeros(16)
{
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = i;
  const inp = new Uint8Array(16);
  const out = new Uint8Array(64);
  crypto_core_salsa20_8(out, inp, key, sigma);
  console.log("Salsa20/8  keystream[0:16]:", hex(out.subarray(0, 16)));
}

// 3) HSalsa20 标准向量：key=00..1f, nonce=16*0 + 00 00 00 00 4a 00 00 00
{
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = i;
  const nonce = new Uint8Array(24);
  nonce[20] = 0x4a;
  const out = new Uint8Array(32);
  crypto_core_hsalsa20(out, nonce, key, sigma);
  console.log("HSalsa20 out:", hex(out));
}

// 4) XSalsa20 keystream：zero key, nonce = 01..18 (24 bytes)，长度 33
{
  const key = new Uint8Array(32);
  const nonce = new Uint8Array(24);
  for (let i = 0; i < 24; i++) nonce[i] = i + 1;
  const ks = xsalsa20Keystream(32 + 1, nonce, key);
  console.log("XSalsa20 ks[0:32] (polyKey):", hex(ks.subarray(0, 32)));
  console.log("XSalsa20 ks[32:33]:", hex(ks.subarray(32, 33)));
  // secretbox of single byte 0x01
  const ct = secretboxSeal(new Uint8Array([0x01]), nonce, key);
  console.log("secretbox(0x01, key=0, nonce=01..18):", hex(ct));
  console.log("WANT file1 block: 09 5b 44 6c d6 23 7b bc b0 8d 09 fb 52 4c e5 65 aa");
  // open roundtrip
  const pt = secretboxOpen(ct, nonce, key);
  console.log("open roundtrip:", pt ? hex(pt) : "FAIL");

  // 交叉验证 XSalsa20 keystream：key=00..1f, nonce=01..18, len=64
  {
    const key2 = new Uint8Array(32);
    for (let i = 0; i < 32; i++) key2[i] = i;
    const nonce2 = new Uint8Array(24);
    for (let i = 0; i < 24; i++) nonce2[i] = i + 1;
    const mine = xsalsa20Keystream(64, nonce2, key2);
    const ref = new Uint8Array(64);
    nacl.lowlevel.crypto_stream(ref, 0, 64, nonce2, key2);
    console.log("XSalsa20 mine[0:16]:", hex(mine.subarray(0, 16)));
    console.log("XSalsa20 ref [0:16]:", hex(ref.subarray(0, 16)));
    console.log("XSalsa20 KEYSTREAM MATCH:", hex(mine) === hex(ref));
  }
}
