import { AES } from "../worker/src/crypto/aes";
import { transform, DirectionEncrypt, DirectionDecrypt } from "../worker/src/crypto/eme";

function hex(u8: Uint8Array): string {
  return Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join(" ");
}
function rnd16(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

// 1) AES-256 往返
{
  const key = rnd16(); key[0] = 0x00; // any 32-byte key
  const k32 = new Uint8Array(32);
  k32.set(key);
  const bc = new AES(k32);
  let ok = true;
  for (let t = 0; t < 200; t++) {
    const pt = rnd16();
    const ct = bc.encryptBlock(pt);
    const dt = bc.decryptBlock(ct);
    if (hex(pt) !== hex(dt)) { ok = false; console.log("AES roundtrip FAIL", hex(pt), "->", hex(dt)); break; }
  }
  console.log("AES-256 encrypt/decrypt 往返:", ok ? "OK" : "FAIL");
}

// 2) AES-256 FIPS-197 向量
{
  // key = 00..1f, plain = 00 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = i;
  const pt = new Uint8Array([0x00,0x11,0x22,0x33,0x44,0x55,0x66,0x77,0x88,0x99,0xaa,0xbb,0xcc,0xdd,0xee,0xff]);
  const bc = new AES(key);
  const ct = bc.encryptBlock(pt);
  console.log("AES-256 FIPS ct:", hex(ct));
  console.log("WANT             : 14 f9 8b 95 9d 0a 3c 98 da 4f 1c 4a c9 89 09 4e");
  console.log("MATCH:", hex(ct) === "14 f9 8b 95 9d 0a 3c 98 da 4f 1c 4a c9 89 09 4e");
  const dt = bc.decryptBlock(ct);
  console.log("decrypt back    :", hex(dt), "match:", hex(dt) === hex(pt));
}

// 3) EME 往返（多块）
{
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = i;
  const bc = new AES(key);
  const tweak = new Uint8Array(16);
  let ok = true;
  const sizes = [16, 32, 48, 64, 128];
  for (const sz of sizes) {
    const pt = new Uint8Array(sz);
    for (let i = 0; i < sz; i++) pt[i] = (i * 3 + 1) & 0xff;
    const ct = transform(bc, tweak, pt, DirectionEncrypt);
    const dt = transform(bc, tweak, ct, DirectionDecrypt);
    if (hex(pt) !== hex(dt)) { ok = false; console.log(`EME roundtrip FAIL sz=${sz}`); break; }
  }
  console.log("EME encrypt/decrypt 往返 (16/32/48/64/128):", ok ? "OK" : "FAIL");
}

// 4) EME 单块（文件名 "1" 场景）
{
  const key = new Uint8Array(32); // 全零 nameKey
  const bc = new AES(key);
  const tweak = new Uint8Array(16);
  const pt = new Uint8Array(16);
  pt[0] = "1".charCodeAt(0);
  const ct = transform(bc, tweak, pt, DirectionEncrypt);
  const dt = transform(bc, tweak, ct, DirectionDecrypt);
  console.log("EME 单块 加密:", hex(ct));
  console.log("EME 单块 解密:", hex(dt), "match:", hex(dt) === hex(pt));
}

// 5) AES-256 解密 FIPS 密文
{
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = i;
  const ct = new Uint8Array([0x8e,0xa2,0xb7,0xca,0x51,0x67,0x45,0xbf,0xea,0xfc,0x49,0x90,0x4b,0x49,0x60,0x89]);
  const bc = new AES(key);
  const dt = bc.decryptBlock(ct);
  console.log("AES-256 解密 FIPS ct:", hex(dt));
  console.log("WANT                  : 00 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff");
}

// 6) gmul 自检
{
  // gmul(2,x) 应等于 xtime(x); gmul(3,x)=xtime(x)^x
  function xtime(a:number){const r=a<<1;return (r^((r>>8)&1?0x1b:0))&0xff;}
  // 用文件内 gmul 需 import；这里复制一份做对比
  function gmul(a:number,b:number){let p=0;for(let i=0;i<8;i++){if(b&1)p^=a;const hi=a&0x80;a=(a<<1)&0xff;if(hi)a^=0x1b;b>>=1;}return p&0xff;}
  let ok=true;
  for(let x=0;x<256;x++){ if(gmul(2,x)!==xtime(x)){ok=false;console.log("gmul(2,x)!=xtime",x);break;} if(gmul(3,x)!==(xtime(x)^x)){ok=false;console.log("gmul(3,x) wrong",x);break;} }
  console.log("gmul(2,x)==xtime(x) & gmul(3,x)==xtime^x:", ok?"OK":"FAIL");
}

