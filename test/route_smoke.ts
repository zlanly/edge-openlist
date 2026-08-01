import worker from "../worker/src/index";

async function hit(path: string, env: any) {
  const ctx: any = { waitUntil: () => {} };
  const res = await worker.fetch(new Request("https://e" + path), env, ctx);
  const txt = await res.text();
  const ct = res.headers.get("content-type") || "";
  console.log(`\n=== ${path} -> ${res.status} [${ct}] ===`);
  console.log(txt.slice(0, 200).replace(/\n/g, " "));
  return { status: res.status, txt, ct };
}

async function main() {
  const noDb: any = {
    APP_TITLE: "EdgeOpenList", JWT_SECRET: "x", KV: {}, R2: {},
    ASSETS: { fetch: async () => new Response("<!doctype html><html><body>SPA-INDEX</body></html>", { headers: { "content-type": "text/html" } }) },
  };
  const mockDb: any = {
    prepare: (sql: string) => {
      const stmt: any = {
        bind: () => stmt,
        all: async () => ({ results: [] }),
        first: async () => (sql.includes("COUNT") ? { c: 0 } : null),
        run: async () => ({ meta: { last_row_id: 1 } }),
      };
      return stmt;
    },
  };
  const withDb: any = { ...noDb, DB: mockDb };

  await hit("/setup", noDb);          // 无 D1 -> 友好 HTML 提示，不应是 SPA
  await hit("/api/auth/setup", noDb); // 同上（另一入口）
  await hit("/setup", withDb);       // 有 D1 -> 初始化完成 HTML
  await hit("/api/auth/needs-setup", withDb); // -> {"needed":true}
  await hit("/api/auth/needs-setup", noDb);    // -> {"needed":false,"reason":"no-d1"}
  await hit("/api/health", withDb);
}

main().catch((e) => { console.error("THREW:", e); process.exit(1); });
