import { Hono } from "hono";
import type { AppEnv, FileItem, MountRow } from "../types";
import { authMiddleware } from "../middleware/auth";
import { getStore } from "../db/store";
import { buildDriver } from "../drivers/factory";
import { normalizePath, sortItems, basename } from "../drivers";

const dav = new Hono<AppEnv>();
dav.use("*", authMiddleware);

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
}
function fmtDate(ms: number): string {
  return new Date(ms || Date.now()).toUTCString();
}
function itemToResponse(mountName: string, baseHref: string, it: FileItem): string {
  const href = baseHref.replace(/\/$/, "") + "/" + encodeURIComponent(it.name);
  const resType = it.is_dir ? "<D:resourcetype><D:collection/></D:resourcetype>" : "<D:resourcetype/>";
  const len = it.is_dir ? "" : `<D:getcontentlength>${it.size}</D:getcontentlength>`;
  const mod = it.modified ? `<D:getlastmodified>${fmtDate(it.modified)}</D:getlastmodified>` : "";
  return `<D:response>
<D:href>${esc(href)}</D:href>
<D:propstat><D:prop>
<D:displayname>${esc(it.name)}</D:displayname>
${resType}
${len}
${mod}
</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response>`;
}

dav.all("*", async (c) => {
  const full = c.req.path.replace(/^\/dav/, "");
  const parts = full.split("/").filter(Boolean);
  if (parts.length === 0) return c.text("需要挂载ID，例�? /dav/1/路径", 400);
  const mountId = Number(parts[0]);
  const mount: MountRow | null = await getStore(c.env).getMount(mountId);
  if (!mount || !mount.enabled) return c.text("挂载不存�?", 404);
  const relPath = "/" + parts.slice(1).map(decodeURIComponent).join("/");
  const path = normalizePath(relPath);
  const driver = await buildDriver(c.env, mount);

  const method = c.req.method.toUpperCase();
  const baseHref = `/dav/${mountId}`;

  // OPTIONS
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: { DAV: "1,2", Allow: "OPTIONS,GET,HEAD,PUT,DELETE,MKCOL,MOVE,COPY,PROPFIND", "Content-Length": "0" },
    });
  }

  // PROPFIND
  if (method === "PROPFIND") {
    const depth = c.req.header("Depth") || "1";
    let items: FileItem[] = [];
    let isFolder = path === "/";
    try {
      items = sortItems(await driver.list(path));
      isFolder = items.length > 0 || path === "/";
    } catch {
      isFolder = false;
    }
    if (!isFolder) {
      try {
        const f = await driver.get(path);
        const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${itemToResponse(mount.name, baseHref + path, f)}</D:multistatus>`;
        return new Response(xml, { status: 207, headers: { "Content-Type": "application/xml; charset=utf-8" } });
      } catch {
        return c.text("不存�?", 404);
      }
    }
    let responses = itemToResponse(mount.name, baseHref, {
      name: basename(path) || mount.name,
      path,
      is_dir: true,
      size: 0,
      modified: 0,
    });
    if (depth !== "0") {
      responses += items.map((it) => itemToResponse(mount.name, baseHref + path, it)).join("");
    }
    const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${responses}</D:multistatus>`;
    return new Response(xml, { status: 207, headers: { "Content-Type": "application/xml; charset=utf-8" } });
  }

  // GET / HEAD：流式下�?
  if (method === "GET" || method === "HEAD") {
    const range = c.req.header("Range") || undefined;
    try {
      const res = await driver.getContent(path, range);
      const body = typeof res === "string" ? (await fetch(res, { headers: range ? { Range: range } : {} })).body : res.body;
      const headers = typeof res === "string" ? (await fetch(res, { headers: range ? { Range: range } : {} })).headers : (res as Response).headers;
      return new Response(method === "HEAD" ? null : body, { status: (res as Response).status || 200, headers });
    } catch {
      return c.text("不存�?", 404);
    }
  }

  // PUT：代理上传（凭据留在服务端）
  if (method === "PUT") {
    if (!driver.putContent) return c.text("该驱动不支持 WebDAV 上传", 400);
    await driver.putContent(path, c.req.raw.body as ReadableStream, c.req.header("Content-Type"));
    return new Response(null, { status: 201 });
  }

  // DELETE
  if (method === "DELETE") {
    await driver.remove(path);
    return new Response(null, { status: 204 });
  }

  // MKCOL
  if (method === "MKCOL") {
    await driver.mkdir(path);
    return new Response(null, { status: 201 });
  }

  // MOVE / COPY：Destination 含目标路径，假定同一挂载
  if (method === "MOVE" || method === "COPY") {
    const dest = c.req.header("Destination") || "";
    const destPath = normalizePath(decodeURIComponent(new URL(dest).pathname.replace(/^\/dav\/\d+/, "")));
    await driver.move(path, destPath);
    return new Response(null, { status: 204 });
  }

  // LOCK / UNLOCK：占位，满足 Finder 等客户端
  if (method === "LOCK" || method === "UNLOCK") {
    return new Response(null, { status: 200 });
  }

  return c.text("不支持的方法", 405);
});

export default dav;
