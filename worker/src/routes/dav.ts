import { Hono } from "hono";
import type { AppEnv, AppContext, FileItem, MountRow } from "../types";
import { getStore } from "../db/store";
import { buildDriver } from "../drivers/factory";
import { normalizePath, sortItems, basename } from "../drivers";
import { extractToken, verifyPassword, verifyToken } from "../util/auth";
import { badRequest, notFound, unsupported, withDriver } from "../util/errors";
import { assertUpstreamOk, buildContentResponse, proxyDirectLink } from "../util/content";

const dav = new Hono<AppEnv>();

// ---------- 鉴权 ----------
// 原实现只认 Bearer JWT，但 Windows 资源管理器 / macOS Finder / RaiDrive
// 这些 WebDAV 客户端只会发 Basic —— 于是 /dav 对真实客户端 100% 401。
// 这里两种都接受，并在缺失时回 401 + WWW-Authenticate 触发客户端弹框。
function davChallenge(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="EdgeOpenList WebDAV", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

dav.use("*", async (c, next) => {
  const header = c.req.header("Authorization") || "";

  const bearer = extractToken(header);
  if (bearer) {
    const user = await verifyToken(c.env, bearer);
    if (!user) return davChallenge();
    c.set("user", user);
    return next();
  }

  const m = header.match(/^Basic\s+(.+)$/i);
  if (m) {
    let decoded = "";
    try {
      decoded = new TextDecoder().decode(Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0)));
    } catch {
      return davChallenge();
    }
    const idx = decoded.indexOf(":");
    if (idx < 0) return davChallenge();
    const username = decoded.slice(0, idx);
    const password = decoded.slice(idx + 1);
    const u = await getStore(c.env).getUserByName(username);
    if (!u || !(await verifyPassword(password, u.password_hash))) return davChallenge();
    c.set("user", { id: u.id, username: u.username, role: u.role });
    return next();
  }

  return davChallenge();
});

// ---------- XML 工具 ----------
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch]!));
}
function fmtDate(ms: number): string {
  return new Date(ms || Date.now()).toUTCString();
}
/** href 需逐段编码：整段 encodeURIComponent 会把 / 也编掉，导致客户端无法下钻。 */
function encodeHref(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}
function itemToResponse(baseHref: string, relPath: string, it: FileItem): string {
  const href = encodeHref(`${baseHref.replace(/\/$/, "")}${relPath}`);
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
function xml(body: string, status = 207): Response {
  return new Response(`<?xml version="1.0" encoding="utf-8"?>\n${body}`, {
    status,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
function textPlain(msg: string, status: number): Response {
  return new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/** 把 /dav/:id 下的相对路径解析成挂载内真实路径（此前完全忽略了 mount.root）。 */
function resolve(mount: MountRow, rel: string): string {
  const root = normalizePath(mount.root || "/");
  const p = normalizePath(rel || "/");
  if (p.includes("..")) throw badRequest("路径非法");
  return root === "/" ? p : normalizePath(root + p);
}

dav.all("*", async (c: AppContext) => {
  const full = c.req.path.replace(/^\/dav/, "");
  const parts = full.split("/").filter(Boolean);
  if (parts.length === 0) {
    return textPlain("需要指定挂载 ID，例如 /dav/1/路径", 400);
  }
  const mountId = Number(parts[0]);
  if (!Number.isInteger(mountId) || mountId < 0) return textPlain("挂载 ID 非法", 400);

  const mount: MountRow | null = await getStore(c.env).getMount(mountId);
  if (!mount || !mount.enabled) return textPlain("挂载不存在或已禁用", 404);

  const relPath = "/" + parts.slice(1).map(decodeURIComponent).join("/");
  const path = resolve(mount, relPath);
  const driver = await withDriver(mount.name, () => buildDriver(c.env, mount));

  const method = c.req.method.toUpperCase();
  const baseHref = `/dav/${mountId}`;

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        DAV: "1,2",
        Allow: "OPTIONS,GET,HEAD,PUT,DELETE,MKCOL,MOVE,COPY,PROPFIND,LOCK,UNLOCK",
        "MS-Author-Via": "DAV",
        "Content-Length": "0",
      },
    });
  }

  if (method === "PROPFIND") {
    const depth = c.req.header("Depth") ?? "1";
    let items: FileItem[] | null = null;
    try {
      items = sortItems(await driver.list(path));
    } catch {
      items = null;
    }

    if (items === null) {
      // 不是目录 -> 当作单个文件返回
      try {
        const f = await driver.get(path);
        return xml(`<D:multistatus xmlns:D="DAV:">${itemToResponse(baseHref, relPath, f)}</D:multistatus>`);
      } catch {
        return textPlain("资源不存在", 404);
      }
    }

    let responses = itemToResponse(baseHref, relPath, {
      name: basename(relPath) || mount.name,
      path: relPath,
      is_dir: true,
      size: 0,
      modified: 0,
    });
    if (depth !== "0") {
      const prefix = relPath === "/" ? "" : relPath.replace(/\/$/, "");
      responses += items.map((it) => itemToResponse(baseHref, `${prefix}/${it.name}`, it)).join("");
    }
    return xml(`<D:multistatus xmlns:D="DAV:">${responses}</D:multistatus>`);
  }

  if (method === "GET" || method === "HEAD") {
    const range = c.req.header("Range") || undefined;
    const name = basename(relPath) || mount.name;
    const res = await withDriver(mount.name, () => driver.getContent(path, range));

    // 原实现对直链 fetch 了**两次**（一次取 body、一次取 headers）：
    // 流量翻倍，而且很多网盘的直链是一次性的，第二次必然失败 -> 下载空文件。
    let out: Response;
    if (typeof res === "string") {
      out = await proxyDirectLink(res, mount.name, name, true, range);
    } else {
      assertUpstreamOk(res, mount.name);
      out = buildContentResponse(res, name, true);
    }
    if (method === "HEAD") {
      // HEAD 必须丢弃 body 但保留头（含 Content-Length），否则客户端算不出文件大小
      return new Response(null, { status: out.status, headers: out.headers });
    }
    return out;
  }

  if (method === "PUT") {
    if (!driver.putContent) return textPlain("该驱动不支持 WebDAV 上传", 405);
    const body = c.req.raw.body;
    if (!body) return textPlain("上传内容为空", 400);
    await withDriver(mount.name, () =>
      driver.putContent!(path, body as ReadableStream, c.req.header("Content-Type"), Number(c.req.header("Content-Length") || 0))
    );
    return new Response(null, { status: 201 });
  }

  if (method === "DELETE") {
    await withDriver(mount.name, () => driver.remove(path));
    return new Response(null, { status: 204 });
  }

  if (method === "MKCOL") {
    await withDriver(mount.name, () => driver.mkdir(path));
    return new Response(null, { status: 201 });
  }

  if (method === "MOVE" || method === "COPY") {
    const dest = c.req.header("Destination") || "";
    if (!dest) return textPlain("缺少 Destination 头", 400);
    let destRel: string;
    try {
      // Destination 可能是绝对 URL，也可能是绝对路径
      const pathname = dest.startsWith("http") ? new URL(dest).pathname : dest;
      destRel = normalizePath(decodeURIComponent(pathname.replace(/^\/dav\/\d+/, "")));
    } catch {
      return textPlain("Destination 头非法", 400);
    }
    if (method === "COPY") throw unsupported("暂不支持 COPY，请改用移动或重新上传");
    await withDriver(mount.name, () => driver.move(path, resolve(mount, destRel)));
    return new Response(null, { status: 204 });
  }

  if (method === "LOCK") {
    // 占位锁：Finder / Office 会先 LOCK 再写入，返回一个假 token 即可放行
    const token = `opaquelocktoken:${crypto.randomUUID()}`;
    return new Response(
      `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>
<D:locktype><D:write/></D:locktype>
<D:lockscope><D:exclusive/></D:lockscope>
<D:depth>infinity</D:depth>
<D:timeout>Second-3600</D:timeout>
<D:locktoken><D:href>${token}</D:href></D:locktoken>
</D:activelock></D:lockdiscovery></D:prop>`,
      { status: 200, headers: { "Content-Type": "application/xml; charset=utf-8", "Lock-Token": `<${token}>` } }
    );
  }
  if (method === "UNLOCK") return new Response(null, { status: 204 });

  return textPlain("不支持的方法", 405);
});

export default dav;
