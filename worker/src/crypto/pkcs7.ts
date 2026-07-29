// PKCS7 填充 / 去填充（块大小 16），用于 rclone 文件名加密前的明文对齐。

export function pkcs7Pad(blockSize: number, data: Uint8Array): Uint8Array {
  const pad = blockSize - (data.length % blockSize);
  const out = new Uint8Array(data.length + pad);
  out.set(data, 0);
  for (let i = data.length; i < out.length; i++) out[i] = pad;
  return out;
}

export function pkcs7Unpad(blockSize: number, data: Uint8Array): Uint8Array {
  if (data.length === 0) throw new Error("empty data");
  if (data.length % blockSize !== 0) throw new Error("data not a multiple of block size");
  const pad = data[data.length - 1];
  if (pad < 1 || pad > blockSize) throw new Error("bad padding");
  for (let i = data.length - pad; i < data.length; i++) {
    if (data[i] !== pad) throw new Error("bad padding");
  }
  return data.subarray(0, data.length - pad);
}
