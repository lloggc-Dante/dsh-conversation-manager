/**
 * dsh-conversation-manager — host half.
 *
 * The sidebar gives a session only "archive", which keeps the conversation
 * stored and merely hides it from the list. This plugin adds a real delete: one
 * red row in a session's "..." menu (see client.js) calls the authenticated
 * route below, and the host half removes the durable session store.
 *
 *   POST /api/conversation-manager/delete   { "sessionId": "session-…" }
 *
 * Effects of one call:
 *   1. `$DSH_HOME/sessions/<cwd-group>/<sessionId>/` is removed (the whole
 *      `session.v4.jsonl.zstd` store of that conversation).
 *   2. `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json` is
 *      removed (stale projection cache).
 *   3. the id is detached from the workspace registry and dropped from the
 *      archived / pinned id lists, so the row stops being listed.
 *
 * Deletion is irreversible: there is no trash, exactly like `rm -rf`.
 */
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const ROUTE = '/api/conversation-manager/delete';
const ACTION_HEADER = 'x-dsh-conversation-manager';
const BODY_LIMIT = 64 * 1024;
/** Session ids are opaque, but they are also used as a directory name. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,199}$/;

const json = (status, value) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const fail = (status, message) => json(status, { ok: false, message });

const textOf = (error) => (error instanceof Error ? error.message : String(error));

const warn = (...args) => {
  try {
    console.warn('[conversation-manager]', ...args);
  } catch {
    /* console may be gone during shutdown */
  }
};

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Resolve a host service without hard-failing when the profile does not have it. */
function service(ctx, name) {
  try {
    const found = ctx.get?.(name);
    if (found) return found;
  } catch {
    /* optional access */
  }
  try {
    return ctx[name];
  } catch {
    return undefined;
  }
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : path.join(homedir(), '.dsh');
}

/** Same-origin guard: reject cross-site / cross-origin callers. */
function originVerdict(request) {
  const site = request.headers.get('sec-fetch-site');
  if (site && !['same-origin', 'none'].includes(site)) return fail(403, '拒绝跨站请求');
  const origin = request.headers.get('origin');
  if (origin && /^https?:/i.test(origin)) {
    try {
      const host = request.headers.get('host') || new URL(request.url).host;
      if (new URL(origin).host !== host) return fail(403, '拒绝跨源请求');
    } catch {
      return fail(403, '无效来源');
    }
  }
  return undefined;
}

async function readJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, '缺少请求内容');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) {
        await reader.cancel();
        throw new RequestError(413, '请求内容过大');
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) throw new RequestError(400, '请求内容为空');
  try {
    return JSON.parse(raw);
  } catch {
    throw new RequestError(400, '请求内容不是合法 JSON');
  }
}

/**
 * Remove the durable store. The cwd group directory name is derived from the
 * session header cwd with an escaping scheme we must not re-implement, so the
 * group is discovered by scanning `sessions/*` for a child named after the id.
 */
async function removeStorage(sessionId) {
  const home = dshHome();
  const sessionsRoot = path.join(home, 'sessions');
  let groups = [];
  try {
    groups = await fsp.readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const targets = [];
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const candidate = path.join(sessionsRoot, group.name, sessionId);
    try {
      if ((await fsp.stat(candidate)).isDirectory()) targets.push(candidate);
    } catch {
      /* not this group */
    }
  }
  const removed = [];
  for (const dir of targets) {
    try {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
      removed.push(dir);
    } catch (error) {
      const busy = ['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error?.code);
      throw new RequestError(
        409,
        busy
          ? '会话数据仍被占用，请先停止这个对话（换一个对话再删）后重试。'
          : '删除会话数据失败：' + textOf(error),
      );
    }
  }
  const cache = path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
  try {
    await fsp.rm(cache, { force: true });
    removed.push(cache);
  } catch {
    /* a stale projection cache is harmless */
  }
  return { groups: targets.length, removed };
}

/** Forget the id in the workspace registry so the sidebar stops listing it. */
async function forgetInRegistry(ctx, sessionId) {
  const registry = service(ctx, 'workspaceRegistry');
  if (!registry || typeof registry.list !== 'function') return { detached: false, reason: 'registry-unavailable' };
  let detached = false;
  for (const workspace of registry.list()) {
    const ids = workspace?.sessionIds;
    if (!Array.isArray(ids) || !ids.includes(sessionId)) continue;
    try {
      await workspace.detachSession(sessionId);
      detached = true;
    } catch (error) {
      warn('detachSession failed', textOf(error));
    }
  }
  if (typeof registry.unarchiveSession === 'function') {
    try {
      await registry.unarchiveSession(sessionId);
    } catch {
      /* not archived */
    }
  }
  if (typeof registry.unpinSession === 'function') {
    try {
      await registry.unpinSession(sessionId);
    } catch {
      /* not pinned */
    }
  }
  return { detached };
}

async function handleDelete(ctx, request) {
  if (request.method !== 'POST') return fail(405, '请使用 POST');
  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json' || request.headers.get(ACTION_HEADER) !== '1') {
    return fail(403, '请从侧栏会话菜单删除对话');
  }
  const denied = originVerdict(request);
  if (denied) return denied;
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return fail(error?.status || 400, textOf(error));
  }
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!SAFE_ID.test(sessionId) || sessionId.includes('..')) return fail(400, '无效的会话 ID');
  try {
    const storage = await removeStorage(sessionId);
    const cleanup = await forgetInRegistry(ctx, sessionId);
    return json(200, {
      ok: true,
      sessionId,
      removedGroups: storage.groups,
      removedPaths: storage.removed.length,
      detached: cleanup.detached,
    });
  } catch (error) {
    warn('delete failed', sessionId, textOf(error));
    return fail(error?.status || 500, textOf(error));
  }
}

export function apply(ctx) {
  const install = (host) => {
    const carrier = host?.connection?.fetch;
    if (typeof carrier?.register !== 'function') {
      warn('connection.fetch unavailable; delete route not registered');
      return;
    }
    try {
      const dispose = carrier.register({
        path: ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handleDelete(ctx, request),
      });
      if (typeof dispose?.catch === 'function') dispose.catch((error) => warn('route registration failed', textOf(error)));
    } catch (error) {
      warn('route registration failed', textOf(error));
    }
  };
  if (typeof ctx.inject === 'function') ctx.inject(['connection'], install);
  else install(ctx);
}
