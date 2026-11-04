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
 *   1. the session's own directory `<DSH_HOME>/sessions/<cwd group>/<id>/` is
 *      removed together with its `session.v4.jsonl.zstd` log;
 *   2. its projection-cache record is removed;
 *   3. the id is detached from every workspace and dropped from the archived /
 *      pinned id lists, so the sidebar stops listing it.
 *
 * Both on-disk names are escaped: the cwd group by `projectKey()` and the
 * session directory by `encodeSegment()`. Those two escapes are mirrored below
 * from `@deepseek-ai/dsh-session-persistence-jsonl`; the session directory is
 * also discovered by scanning the group directories, and the exact group is
 * derived from the session header cwd through `sessionPersistence.stat()`.
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
const SAFE_SEGMENT = /^[A-Za-z0-9._-]$/;

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

/* ------------------------------------------------------------------------- *
 * Mirror of the persistence backend's path escapes.
 * ------------------------------------------------------------------------- */

/** `encodeSegment()` from the jsonl persistence backend: one safe path segment. */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && SAFE_SEGMENT.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/** `projectKey()` from the jsonl persistence backend: the cwd group directory. */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && SAFE_SEGMENT.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
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

const isDirectory = async (candidate) => {
  try {
    return (await fsp.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Every directory that may hold this session: the exact one derived from the
 * header cwd, plus any group that happens to contain the escaped id.
 */
async function locateSessionDirs(ctx, sessionId) {
  const home = dshHome();
  const sessionsRoot = path.join(home, 'sessions');
  const found = new Set();

  const persistence = service(ctx, 'sessionPersistence');
  if (persistence && typeof persistence.stat === 'function') {
    try {
      const snapshot = await persistence.stat(sessionId);
      const cwd = snapshot?.header?.cwd;
      if (typeof cwd === 'string' && cwd.length > 0) {
        const group = cwd === void 0 ? '_no-cwd' : projectKey(cwd);
        const exact = path.join(sessionsRoot, group, encodeSegment(sessionId));
        if (await isDirectory(exact)) found.add(exact);
      } else if (snapshot) {
        const noCwd = path.join(sessionsRoot, '_no-cwd', encodeSegment(sessionId));
        if (await isDirectory(noCwd)) found.add(noCwd);
      }
    } catch (error) {
      warn('sessionPersistence.stat failed', sessionId, textOf(error));
    }
  }

  let groups = [];
  try {
    groups = await fsp.readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const escaped = encodeSegment(sessionId);
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    for (const name of new Set([escaped, sessionId])) {
      const candidate = path.join(sessionsRoot, group.name, name);
      if (await isDirectory(candidate)) found.add(candidate);
    }
  }
  return [...found];
}

/** Remove the durable store plus its projection-cache record. */
async function removeStorage(ctx, sessionId, targets) {
  const home = dshHome();
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
  const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions');
  for (const name of new Set([`${sessionId}.json`, `${encodeSegment(sessionId)}.json`])) {
    const cache = path.join(cacheDir, name);
    try {
      await fsp.rm(cache, { force: true });
      removed.push(cache);
    } catch {
      /* a stale projection cache is harmless */
    }
  }
  return { targets, removed };
}

/**
 * Hide the row immediately. Deleting the log makes the session disappear on the
 * next list refresh, but an already-open page keeps its last snapshot; marking
 * the id archived makes the sidebar drop that row at once, and the journal below
 * clears the marker again once the store is gone.
 */
async function hideSession(ctx, sessionId) {
  const registry = service(ctx, 'workspaceRegistry');
  if (!registry || typeof registry.archiveSession !== 'function') return false;
  try {
    await registry.archiveSession(sessionId, { stopActivity: true });
    return true;
  } catch (error) {
    warn('archiveSession failed', sessionId, textOf(error));
    return false;
  }
}

const journalPath = () => path.join(dshHome(), 'storages', 'conversation-manager', 'archived.json');

async function readJournal() {
  try {
    const parsed = JSON.parse(await fsp.readFile(journalPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

async function writeJournal(ids) {
  try {
    const file = journalPath();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify([...new Set(ids)], null, 2), 'utf8');
  } catch (error) {
    warn('journal write failed', textOf(error));
  }
}

/**
 * Startup sweep: an id we archived while deleting may sit in the archive list
 * after its store is gone. Unarchive those so the archived view does not keep a
 * ghost; ids whose store still exists stay archived (the delete failed).
 */
async function pruneArchivedGhosts(ctx) {
  const journal = await readJournal();
  if (journal.length === 0) return;
  const registry = service(ctx, 'workspaceRegistry');
  const persistence = service(ctx, 'sessionPersistence');
  if (!registry || typeof registry.unarchiveSession !== 'function') return;
  const keep = [];
  for (const id of journal) {
    let exists = true;
    try {
      exists = Boolean(await persistence?.stat?.(id));
    } catch {
      exists = true;
    }
    if (exists) {
      keep.push(id);
      continue;
    }
    try {
      await registry.unarchiveSession(id);
    } catch (error) {
      warn('unarchive ghost failed', id, textOf(error));
      keep.push(id);
    }
  }
  await writeJournal(keep);
}

/** Drop the id from every workspace, and from the archived / pinned id lists. */
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
    const targets = await locateSessionDirs(ctx, sessionId);
    if (targets.length === 0) {
      // Nothing on disk: report the truth instead of pretending success, so a
      // conversation that still shows up can be diagnosed instead of silently
      // "deleted" while it keeps living in the sidebar.
      return json(404, {
        ok: false,
        message: '没有找到这个对话的存储文件（可能已经被删除了）。',
        sessionId,
      });
    }
    // Stop any running work and hide the row before the store goes away; a live
    // agent would otherwise keep writing to the directory being removed.
    const hidden = await hideSession(ctx, sessionId);
    let storage;
    try {
      storage = await removeStorage(ctx, sessionId, targets);
    } catch (error) {
      if (hidden) {
        try {
          await service(ctx, 'workspaceRegistry')?.unarchiveSession?.(sessionId);
        } catch {
          /* keep the row hidden rather than resurrect a half-deleted row */
        }
      }
      throw error;
    }
    const cleanup = await forgetInRegistry(ctx, sessionId);
    if (hidden) await writeJournal([...(await readJournal()), sessionId]);
    // A still-live container can recreate the store right after removal; sweep
    // once more so "deleted" is not undone by a late flush.
    let swept = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const again = await locateSessionDirs(ctx, sessionId);
      if (again.length === 0) break;
      try {
        await removeStorage(ctx, sessionId, again);
        swept += again.length;
      } catch (error) {
        warn('sweep failed', sessionId, textOf(error));
        break;
      }
    }
    return json(200, {
      ok: true,
      sessionId,
      removedGroups: storage.targets.length,
      removedPaths: storage.removed.length,
      swept,
      detached: cleanup.detached,
      hidden,
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
  // A delete archives the row to hide it at once, then clears that marker on a
  // later boot, once the store it referred to is gone.
  try {
    const timer = setTimeout(() => {
      pruneArchivedGhosts(ctx).catch((error) => warn('prune failed', textOf(error)));
    }, 4000);
    timer?.unref?.();
  } catch (error) {
    warn('prune scheduling failed', textOf(error));
  }
}
