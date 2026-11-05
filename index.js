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
 * Deletion is irreversible: there is no trash, exactly like `rm -rf`. A deleted
 * id is also remembered (tombstoned) for a while: a Session that is still
 * resident can flush its log back to disk after the delete, so a small sweeper
 * keeps removing that copy and keeps the row off every open page.
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

/**
 * A deleted id is remembered for a while: a session that is still resident in
 * the host keeps a writer alive and can flush its log back to disk, which made
 * the row reappear after a "successful" delete. The tombstone lets the sweeper
 * remove the recreated store again until the writer is gone.
 */
const DELETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ENFORCE_WINDOW_MS = 10 * 60 * 1000;
const ENFORCE_INTERVAL_MS = 2500;

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

/** Remove the projection-cache record that mirrors the session summary. */
async function removeProjectionCache(sessionId) {
  const cacheDir = path.join(dshHome(), 'storages', 'session_projcache', 'sessions');
  for (const name of new Set([`${sessionId}.json`, `${encodeSegment(sessionId)}.json`])) {
    try {
      await fsp.rm(path.join(cacheDir, name), { force: true });
    } catch {
      /* a stale projection cache is harmless */
    }
  }
}

/** Remove the durable store plus its projection-cache record. */
async function removeStorage(ctx, sessionId, targets) {
  const removed = [];
  for (const dir of targets) {
    try {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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
  await removeProjectionCache(sessionId);
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

/**
 * Tell every open page that this Session is gone. `api-session/removed` is a
 * forwarded Host event (`dsh-api-remotes` allowlist) and the session client
 * applies it as a row removal, so the sidebar drops the row without a reload and
 * without leaving an "archived" marker behind.
 */
function announceRemoval(ctx, sessionId) {
  try {
    if (typeof ctx.emit !== 'function') return false;
    ctx.emit('api-session/removed', sessionId);
    return true;
  } catch (error) {
    warn('announceRemoval failed', sessionId, textOf(error));
    return false;
  }
}

/** `api-session/removed` relay bookkeeping for the boot sweep. */
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

/* -------------------------------------------------------------------------- *
 * Deleted-session tombstones.
 *
 * Deleting the store is not enough while the session is still resident: the
 * host keeps a writer for an open conversation and flushes it again, recreating
 * the exact directory we just removed. The row then reappears and the next
 * delete either races the writer or finds nothing on disk. Remembering the id
 * (and the paths we removed) lets a small sweeper keep the store deleted and
 * keep the row off every open page until the writer is gone.
 * -------------------------------------------------------------------------- */

const deletedPath = () => path.join(dshHome(), 'storages', 'conversation-manager', 'deleted.json');
/** sessionId -> { at, dirs } */
const deletedIds = new Map();
let deletedLoaded = false;
let enforceTimer;
let enforceCtx;

async function loadDeleted() {
  if (deletedLoaded) return;
  deletedLoaded = true;
  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(deletedPath(), 'utf8'));
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const now = Date.now();
  for (const [id, entry] of Object.entries(parsed)) {
    if (typeof id !== 'string' || !SAFE_ID.test(id)) continue;
    const at = typeof entry === 'number' ? entry : typeof entry?.at === 'number' ? entry.at : now;
    if (now - at > DELETED_TTL_MS) continue;
    const dirs = Array.isArray(entry?.dirs) ? entry.dirs.filter((value) => typeof value === 'string') : [];
    deletedIds.set(id, { at, dirs });
  }
}

async function saveDeleted() {
  try {
    const file = deletedPath();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const now = Date.now();
    const payload = {};
    for (const [id, entry] of [...deletedIds]) {
      if (now - entry.at > DELETED_TTL_MS) {
        deletedIds.delete(id);
        continue;
      }
      payload[id] = { at: entry.at, dirs: entry.dirs };
    }
    await fsp.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  } catch (error) {
    warn('deleted journal write failed', textOf(error));
  }
}

/** Remember a deleted id and start the sweeper that keeps it deleted. */
async function rememberDeleted(ctx, sessionId, dirs) {
  await loadDeleted();
  const previous = deletedIds.get(sessionId);
  const kept = new Set([...(previous?.dirs ?? []), ...(dirs ?? [])]);
  deletedIds.set(sessionId, { at: Date.now(), dirs: [...kept] });
  await saveDeleted();
  startEnforcement(ctx);
}

function startEnforcement(ctx) {
  if (!enforceCtx) enforceCtx = ctx;
  if (enforceTimer) return;
  enforceTimer = setInterval(() => {
    enforceDeleted(enforceCtx).catch((error) => warn('deleted sweep failed', textOf(error)));
  }, ENFORCE_INTERVAL_MS);
  enforceTimer?.unref?.();
}

/** Remove recreated stores for tombstoned ids and keep their rows out of the list. */
async function enforceDeleted(ctx) {
  await loadDeleted();
  if (deletedIds.size === 0) return;
  if (enforceTimer === undefined) startEnforcement(ctx);
  const now = Date.now();
  let changed = false;
  let budget = 50;
  for (const [sessionId, entry] of [...deletedIds]) {
    if (budget-- <= 0) break;
    if (now - entry.at > DELETED_TTL_MS) {
      deletedIds.delete(sessionId);
      changed = true;
      continue;
    }
    let removed = 0;
    if (entry.dirs.length === 0) {
      // The store was already gone at delete time; look for a recreated one.
      try {
        entry.dirs = await locateSessionDirs(ctx, sessionId);
        changed = entry.dirs.length > 0 || changed;
      } catch (error) {
        warn('deleted lookup failed', sessionId, textOf(error));
      }
    }
    for (const dir of [...entry.dirs]) {
      try {
        if (!(await isDirectory(dir))) continue;
        await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        removed += 1;
      } catch (error) {
        warn('deleted removal failed', sessionId, textOf(error));
      }
    }
    if (removed > 0) {
      await removeProjectionCache(sessionId);
      try {
        await forgetInRegistry(ctx, sessionId);
      } catch (error) {
        warn('deleted detach failed', sessionId, textOf(error));
      }
      announceRemoval(ctx, sessionId);
      changed = true;
    } else if (now - entry.at < ENFORCE_WINDOW_MS) {
      // The row can be re-announced by the host while the session is resident;
      // keep telling the pages it is gone until that window closes.
      announceRemoval(ctx, sessionId);
    }
  }
  if (changed) await saveDeleted();
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
      // Nothing on disk. The row may still be listed from the live session or a
      // stale projection; forget it in the registry, keep the tombstone so a
      // late flush cannot bring it back, and report success so the phantom row
      // can be dismissed instead of erroring forever.
      const cleanup = await forgetInRegistry(ctx, sessionId);
      await removeProjectionCache(sessionId);
      await rememberDeleted(ctx, sessionId, []);
      const announced = announceRemoval(ctx, sessionId);
      return json(200, {
        ok: true,
        sessionId,
        missing: true,
        removedGroups: 0,
        removedPaths: 0,
        swept: 0,
        detached: cleanup.detached,
        hidden: false,
        archived: false,
        announced,
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
    // Remember the deletion: a resident session can flush its log back to disk
    // after this point, and the sweeper removes that copy again.
    await rememberDeleted(ctx, sessionId, storage.targets);
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
    // Drop the row from every open page, then clear the hiding marker so the
    // conversation is not left sitting in the archived view.
    const announced = announceRemoval(ctx, sessionId);
    let archived = hidden;
    if (hidden && announced) {
      // Let the removal reach the page before the archive set changes again.
      await new Promise((resolve) => setTimeout(resolve, 120));
      try {
        await service(ctx, 'workspaceRegistry')?.unarchiveSession?.(sessionId);
        archived = false;
      } catch (error) {
        warn('clearing archive marker failed', sessionId, textOf(error));
      }
    }
    if (archived) await writeJournal([...(await readJournal()), sessionId]);
    return json(200, {
      ok: true,
      sessionId,
      removedGroups: storage.targets.length,
      removedPaths: storage.removed.length,
      swept,
      detached: cleanup.detached,
      hidden,
      archived,
      announced,
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
  // Startup: unarchive ghosts left by an interrupted delete, then enforce the
  // tombstones once (a resident session may have recreated its store while the
  // app was closed) and keep the sweeper running.
  try {
    const timer = setTimeout(() => {
      loadDeleted()
        .then(() => enforceDeleted(ctx))
        .then(() => startEnforcement(ctx))
        .then(() => pruneArchivedGhosts(ctx))
        .catch((error) => warn('startup sweep failed', textOf(error)));
    }, 3000);
    timer?.unref?.();
  } catch (error) {
    warn('prune scheduling failed', textOf(error));
  }
}
