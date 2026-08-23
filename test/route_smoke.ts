import worker from "../worker/src/index";
import { createToken, hashPassword } from "../worker/src/util/auth";

async function raw(path: string, env: any, headers: Record<string, string> = {}, method = "GET", body?: string) {
  const ctx: any = { waitUntil: () => {} };
  const init: any = { method, headers };
  if (body) init.body = body;
  const res = await worker.fetch(new Request("https://e" + path, init), env, ctx);
  const txt = await res.text();
  return { status: res.status, ct: res.headers.get("content-type") || "", txt };
}

async function main() {
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
  const env: any = {
    APP_TITLE: "EdgeOpenList", JWT_SECRET: "test-secret", KV: {}, R2: {}, DB: mockDb,
    ASSETS: { fetch: async () => new Response("SPA", { headers: { "content-type": "text/html" } }) },
  };

  // 直接签发 admin token（登录链路已在生产验证），重点验证 adminMiddleware
  const token = await createToken(env, { id: 1, username: "admin", role: "admin" });

  // 管理类接口带 token 应 200（adminMiddleware 自带校验）
  const m = await raw("/api/mounts/", env, { Authorization: "Bearer " + token });
  console.log(`/api/mounts/ -> ${m.status} ${m.txt.slice(0, 60)}`);
  const mNoSlash = await raw("/api/mounts", env, { Authorization: "Bearer " + token });
  console.log(`/api/mounts -> ${mNoSlash.status}`);
  const d = await raw("/api/mounts/drivers", env, { Authorization: "Bearer " + token });
  console.log(`/api/mounts/drivers -> ${d.status}`);
  const o = await raw("/api/oauth/providers", env, { Authorization: "Bearer " + token });
  console.log(`/api/oauth/providers -> ${o.status}`);
  const me = await raw("/api/auth/me", env, { Authorization: "Bearer " + token });
  console.log(`/api/auth/me -> ${me.status} ${me.txt.slice(0, 60)}`);
  const create = await raw("/api/mounts/", env, { Authorization: "Bearer " + token, "Content-Type": "application/json" }, "POST", JSON.stringify({ name: "t", driver: "virtual", config: { tree: "{}" } }));
  console.log(`POST /api/mounts/ -> ${create.status}`);

  // 不带 token 应 401
  const noAuth = await raw("/api/mounts/", env);
  console.log(`/api/mounts/ (无 token) -> ${noAuth.status}`);
  const meNoAuth = await raw("/api/auth/me", env);
  console.log(`/api/auth/me (无 token) -> ${meNoAuth.status}`);

  const ok = m.status === 200 && mNoSlash.status === 200 && d.status === 200 && o.status === 200 && me.status === 200 && create.status === 200 && noAuth.status === 401 && meNoAuth.status === 401;
  console.log(ok ? "\n✅ adminMiddleware 修复生效（管理接口鉴权通过）" : "\n❌ 仍有问题");
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error("THREW:", e); process.exit(1); });
