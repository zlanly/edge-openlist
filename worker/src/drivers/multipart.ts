// 流式构造 multipart/form-data 请求体（前缀 + 文件流 + 后缀），不整文件缓冲。
export interface MultipartResult {
  body: ReadableStream<Uint8Array>;
  contentType: string;
}

export function buildMultipart(
  fields: Record<string, string>,
  file: { name: string; stream: ReadableStream<Uint8Array>; contentType?: string },
  boundary = "----EdgeOpenList" + Math.random().toString(36).slice(2)
): MultipartResult {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const push = (s: string) => chunks.push(enc.encode(s));
  for (const [k, v] of Object.entries(fields)) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
      `Content-Type: ${file.contentType || "application/octet-stream"}\r\n\r\n`
  );
  const prefix = concat(chunks);
  const suffix = enc.encode(`\r\n--${boundary}--\r\n`);

  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(prefix);
      const reader = (file.stream as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) c.enqueue(value);
      }
      c.enqueue(suffix);
      c.close();
    },
  });
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
