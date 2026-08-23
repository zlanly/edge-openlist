import { Hono } from "hono";
import type { AppEnv, AppContext, FileItem, MountRow } from "../types";
import { getStore } from "../db/store";
import { buildDriver } from "../drivers/factory";
import { normalizePath, sortItems, basename } from "../drivers";
import { extractToken, verifyPassword, verifyToken } from "../util/auth";
import { badRequest, notFound, unsupported, withDriver } from "../util/errors";
import { assertUpstreamOk, buildContentResponse, proxyDirectLink } from "../util/content";

const dav = new Hono<AppEnv>();

// ---------- ��Ȩ ----------
// ԭʵ��ֻ�� Bearer JWT���� Windows ��Դ������ / macOS Finder / RaiDrive
// ��Щ WebDAV �ͻ���ֻ�ᷢ Basic ���� ���� /dav ����ʵ�ͻ��� 100% 401��
// �������ֶ����ܣ�����ȱʧʱ�� 401 + WWW-Authenticate �����ͻ��˵���
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

// ---------- XML ���� ----------
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch]!));
}
function fmtDate(ms: number): string {
  return new Date(ms || Date.now()).toUTCString();
}
/** href ����α��룺���� encodeURIComponent ��� / Ҳ��������¿ͻ����޷����ꡣ */
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

/** �� /dav/:id �µ����·�������ɹ�������ʵ·������ǰ��ȫ������ mount.root���� */
function resolve(mount: MountRow, rel: string): string {
  const root = normalizePath(mount.root || "/");
  const p = normalizePath(rel || "/");
  if (p.split("/").some((part) => part === "..")) throw badRequest("路径非法");
  return root === "/" ? p : normalizePath(root + p);
}

function assertNotMountRoot(mount: MountRow, path: string, action: string): string {
  const root = normalizePath(mount.root || "/");
  if (normalizePath(path) === root) throw badRequest(`不能${action}挂载根目录`);
  return path;
}

function decodePathPart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw badRequest("路径编码非法");
  }
}

dav.all("*", async (c: AppContext) => {
  const full = c.req.path.replace(/^\/dav/, "");
  const parts = full.split("/").filter(Boolean);
  if (parts.length === 0) {
    return textPlain("��Ҫָ������ ID������ /dav/1/·��", 400);
  }
  const mountId = Number(parts[0]);
  if (!Number.isInteger(mountId) || mountId < 0) return textPlain("���� ID �Ƿ�", 400);

  const mount: MountRow | null = await getStore(c.env).getMount(mountId);
  if (!mount || !mount.enabled) return textPlain("���ز����ڻ��ѽ���", 404);

  const relPath = "/" + parts.slice(1).map(decodePathPart).join("/");
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
      // ����Ŀ¼ -> ���������ļ�����
      try {
        const f = await driver.get(path);
        return xml(`<D:multistatus xmlns:D="DAV:">${itemToResponse(baseHref, relPath, f)}</D:multistatus>`);
      } catch {
        return textPlain("��Դ������", 404);
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

    // ԭʵ�ֶ�ֱ�� fetch ��**����**��һ��ȡ body��һ��ȡ headers����
    // �������������Һܶ����̵�ֱ����һ���Եģ��ڶ��α�Ȼʧ�� -> ���ؿ��ļ���
    let out: Response;
    if (typeof res === "string") {
      out = await proxyDirectLink(res, mount.name, name, true, range);
    } else {
      assertUpstreamOk(res, mount.name);
      out = buildContentResponse(res, name, true);
    }
    if (method === "HEAD") {
      // HEAD ���붪�� body ������ͷ���� Content-Length��������ͻ����㲻���ļ���С
      return new Response(null, { status: out.status, headers: out.headers });
    }
    return out;
  }

  if (method === "PUT") {
    if (!driver.putContent) return textPlain("��������֧�� WebDAV �ϴ�", 405);
    assertNotMountRoot(mount, path, "上传覆盖");
    const body = c.req.raw.body;
    if (!body) return textPlain("�ϴ�����Ϊ��", 400);
    await withDriver(mount.name, () =>
      driver.putContent!(path, body as ReadableStream, c.req.header("Content-Type"), Number(c.req.header("Content-Length") || 0))
    );
    return new Response(null, { status: 201 });
  }

  if (method === "DELETE") {
    assertNotMountRoot(mount, path, "删除");
    await withDriver(mount.name, () => driver.remove(path));
    return new Response(null, { status: 204 });
  }

  if (method === "MKCOL") {
    assertNotMountRoot(mount, path, "创建目录于");
    await withDriver(mount.name, () => driver.mkdir(path));
    return new Response(null, { status: 201 });
  }

  if (method === "MOVE" || method === "COPY") {
    const dest = c.req.header("Destination") || "";
    if (!dest) return textPlain("ȱ�� Destination ͷ", 400);
    let destRel: string;
    try {
      // Destination 可以是绝对 URL，也可以是绝对路径；必须指向当前挂载。
      const parsed = dest.startsWith("http") ? new URL(dest) : null;
      const pathname = parsed ? parsed.pathname : dest;
      const mountPrefix = `/dav/${mountId}`;
      if (parsed && parsed.origin !== new URL(c.req.url).origin) return textPlain("Destination 必须指向当前站点", 400);
      if (!pathname.startsWith(mountPrefix + "/") && pathname !== mountPrefix) return textPlain("Destination 必须指向当前挂载", 400);
      destRel = normalizePath(decodeURIComponent(pathname.slice(mountPrefix.length) || "/"));
    } catch {
      return textPlain("Destination 头非法", 400);
    }
    if (method === "COPY") throw unsupported("暂不支持 COPY，请使用移动或重新上传");
    const target = assertNotMountRoot(mount, resolve(mount, destRel), "移动到");
    if (target === path) return new Response(null, { status: 204 });
    await withDriver(mount.name, () => driver.move(path, target));
    return new Response(null, { status: 204 });
  }

  if (method === "LOCK") {
    // ռλ����Finder / Office ���� LOCK ��д�룬����һ���� token ���ɷ���
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

  return textPlain("��֧�ֵķ���", 405);
});

export default dav;
