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
import { randomUUID } from 'node:crypto';
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

/* -------------------------------------------------------------------------- *
 * Recycle bin.
 *
 * Deleting no longer wipes the store: the session directory is moved into
 * `<DSH_HOME>/storages/conversation-manager/trash/<trashId>/payload-N`, together
 * with a `meta.json` that keeps everything needed to restore it (original path,
 * projection-cache snapshot, original workspace). Entries expire after 30 days
 * and are purged on start, hourly, and whenever the bin is opened.
 * -------------------------------------------------------------------------- */

const TRASH_ROUTE = '/api/conversation-manager/trash';
const TRASH_VERSION = 1;
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SAFE_TRASH_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

const trashRoot = () => path.join(dshHome(), 'storages', 'conversation-manager', 'trash');
const trashEntryDir = (trashId) => path.join(trashRoot(), trashId);
const trashMetaPath = (trashId) => path.join(trashEntryDir(trashId), 'meta.json');

async function readTrashMeta(trashId) {
  if (!SAFE_TRASH_ID.test(trashId)) return null;
  try {
    const parsed = JSON.parse(await fsp.readFile(trashMetaPath(trashId), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.trashId === trashId ? parsed : null;
  } catch {
    return null;
  }
}

async function writeTrashMeta(trashId, meta) {
  const dir = trashEntryDir(trashId);
  await fsp.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `meta.json.${process.pid}.tmp`);
  await fsp.writeFile(temp, JSON.stringify(meta, null, 2), 'utf8');
  await fsp.rename(temp, trashMetaPath(trashId));
}

/** Move a directory, falling back to a copy when the two paths are on different volumes. */
async function movePath(from, to) {
  try {
    await fsp.rename(from, to);
    return;
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
  }
  await fsp.cp(from, to, { recursive: true });
  await fsp.rm(from, { recursive: true, force: true });
}

async function directorySize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += (await fsp.stat(full)).size;
        } catch {
          /* a file that vanished mid-walk contributes nothing */
        }
      }
    }
  }
  return total;
}

async function findProjectionCache(sessionId) {
  const cacheDir = path.join(dshHome(), 'storages', 'session_projcache', 'sessions');
  for (const name of new Set([`${sessionId}.json`, `${encodeSegment(sessionId)}.json`])) {
    try {
      return { name, text: await fsp.readFile(path.join(cacheDir, name), 'utf8') };
    } catch {
      /* try the other spelling */
    }
  }
  return null;
}

async function writeProjectionCache(name, text) {
  try {
    const cacheDir = path.join(dshHome(), 'storages', 'session_projcache', 'sessions');
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(path.join(cacheDir, name), text, 'utf8');
  } catch (error) {
    warn('projection-cache restore failed', name, textOf(error));
  }
}

function workspaceInfoOf(ctx, sessionId) {
  const registry = service(ctx, 'workspaceRegistry');
  if (!registry || typeof registry.list !== 'function') return null;
  for (const workspace of registry.list()) {
    if (Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(sessionId)) {
      return { id: workspace.id, title: typeof workspace.title === 'string' ? workspace.title : '' };
    }
  }
  return null;
}

/** Move one deleted session into the recycle bin; records everything restore needs. */
async function moveSessionToTrash(ctx, sessionId, targets, title) {
  const trashId = randomUUID();
  const dir = trashEntryDir(trashId);
  await fsp.mkdir(dir, { recursive: true });
  const workspace = workspaceInfoOf(ctx, sessionId);
  const cache = await findProjectionCache(sessionId);
  const meta = {
    version: TRASH_VERSION,
    trashId,
    sessionId,
    title: typeof title === 'string' && title.trim().length > 0 ? title.trim() : '',
    deletedAt: Date.now(),
    workspaceId: workspace?.id,
    workspaceTitle: workspace?.title,
    projcacheName: cache?.name,
    projcache: cache?.text ?? null,
    movers: [],
    size: 0,
    state: 'pending',
  };
  await writeTrashMeta(trashId, meta);
  const moved = [];
  try {
    for (let index = 0; index < targets.length; index += 1) {
      const stored = `payload-${index}`;
      await movePath(targets[index], path.join(dir, stored));
      meta.movers.push({ stored, originalPath: targets[index] });
      moved.push({ stored, originalPath: targets[index] });
      await writeTrashMeta(trashId, meta);
    }
  } catch (error) {
    for (const mover of moved.reverse()) {
      try {
        await movePath(path.join(dir, mover.stored), mover.originalPath);
      } catch {
        /* best-effort rollback */
      }
    }
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {
      /* leave the broken entry for the next purge */
    }
    throw new RequestError(409, '移入回收站失败：' + textOf(error));
  }
  if (cache) await fsp.rm(path.join(dshHome(), 'storages', 'session_projcache', 'sessions', cache.name), { force: true }).catch(() => {});
  meta.size = await directorySize(dir);
  meta.state = 'done';
  await writeTrashMeta(trashId, meta);
  return meta;
}

async function purgeTrashEntry(trashId) {
  try {
    await fsp.rm(trashEntryDir(trashId), { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  } catch (error) {
    throw new RequestError(409, '彻底删除失败：' + textOf(error));
  }
}

async function purgeExpiredTrash(ctx) {
  const root = trashRoot();
  let names = [];
  try {
    names = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  const now = Date.now();
  let purged = 0;
  for (const entry of names) {
    if (!entry.isDirectory() || !SAFE_TRASH_ID.test(entry.name)) continue;
    const meta = await readTrashMeta(entry.name);
    if (!meta) continue;
    if (now - (Number(meta.deletedAt) || 0) <= TRASH_RETENTION_MS) continue;
    try {
      await fsp.rm(trashEntryDir(entry.name), { recursive: true, force: true });
      purged += 1;
    } catch (error) {
      warn('trash expiry purge failed', entry.name, textOf(error));
    }
  }
  return purged;
}

async function listTrash(ctx) {
  await purgeExpiredTrash(ctx);
  const root = trashRoot();
  let names = [];
  try {
    names = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const workspaceIds = new Set();
  const registry = service(ctx, 'workspaceRegistry');
  if (registry && typeof registry.list === 'function') {
    for (const workspace of registry.list()) if (workspace?.id) workspaceIds.add(workspace.id);
  }
  const now = Date.now();
  const items = [];
  for (const entry of names) {
    if (!entry.isDirectory() || !SAFE_TRASH_ID.test(entry.name)) continue;
    const meta = await readTrashMeta(entry.name);
    if (!meta || meta.state !== 'done') continue;
    const deletedAt = Number(meta.deletedAt) || now;
    const expiresAt = deletedAt + TRASH_RETENTION_MS;
    items.push({
      trashId: meta.trashId,
      sessionId: meta.sessionId,
      title: typeof meta.title === 'string' && meta.title.length > 0 ? meta.title : '',
      deletedAt,
      expiresAt,
      daysLeft: Math.max(0, Math.ceil((expiresAt - now) / 86_400_000)),
      size: Number(meta.size) || 0,
      workspaceId: meta.workspaceId ?? null,
      workspaceTitle: typeof meta.workspaceTitle === 'string' ? meta.workspaceTitle : '',
      orphaned: Boolean(meta.workspaceId && !workspaceIds.has(meta.workspaceId)),
    });
  }
  items.sort((left, right) => right.deletedAt - left.deletedAt);
  return items;
}

/** Drop a tombstone so the sweeper stops deleting the store we just restored. */
async function forgetDeleted(ctx, sessionId) {
  await loadDeleted();
  if (!deletedIds.has(sessionId)) return;
  deletedIds.delete(sessionId);
  await saveDeleted();
}

/** Rebuild the list summary the Host would send for this cold session. */
async function summarizeRestored(ctx, meta) {
  let header;
  try {
    const snapshot = await service(ctx, 'sessionPersistence')?.stat?.(meta.sessionId);
    header = snapshot?.header ?? snapshot;
  } catch {
    header = undefined;
  }
  const values = {};
  let asOfSeq = 0;
  const summaryKeys = new Set();
  try {
    const projections = service(ctx, 'sessionProjections');
    const keys = typeof projections?.summaryKeys === 'function' ? projections.summaryKeys() : [];
    if (Array.isArray(keys)) for (const key of keys) summaryKeys.add(key);
  } catch {
    /* the summary schema stays open when the projection service is absent */
  }
  if (typeof meta.projcache === 'string') {
    try {
      const parsed = JSON.parse(meta.projcache);
      const rows = parsed?.record?.rows ?? {};
      for (const key of ['title', 'sessionListMetadata', 'agentPreset', 'permissions', 'workingDirectory']) {
        if (summaryKeys.size > 0 && !summaryKeys.has(key)) continue;
        const row = rows?.[key];
        if (row?.val === undefined) continue;
        values[key] = row.val;
        const seq = Number(row.seq);
        if (Number.isFinite(seq)) asOfSeq = Math.max(asOfSeq, seq);
      }
    } catch {
      /* a corrupt checkpoint only costs the row its title until it reopens */
    }
  }
  if (values.title === undefined && meta.title) values.title = meta.title;
  const metadata = values.sessionListMetadata ?? {};
  const blank = metadata.blank === true;
  const lastPromptAt = Number(metadata.lastPromptAt) || 0;
  const createdAt = Number(header?.createdAt) || Number(meta.deletedAt) || Date.now();
  const summary = {
    sessionId: meta.sessionId,
    updatedAt: Math.max(createdAt, lastPromptAt),
    agentAvailable: false,
    formatStatus: 'current',
    running: false,
    blank,
  };
  if (typeof header?.cwd === 'string') summary.cwd = header.cwd;
  if (header?.origin !== undefined) summary.origin = header.origin;
  if (header?.parentSession !== undefined) summary.parentSessionId = header.parentSession;
  // `SessionProjectionHints` requires a watermark even for cached hints; the
  // client ignores it on the cached path but the event schema rejects a summary
  // without it, which is why a restored row never reached the sidebar.
  if (Object.keys(values).length > 0) summary.projections = { kind: 'cached', asOfSeq, values };
  return summary;
}

/** Move one bin entry back to its original path and tell the pages it is listed again. */
async function restoreTrashEntry(ctx, trashId) {
  const meta = await readTrashMeta(trashId);
  if (!meta) throw new RequestError(404, '回收站里没有这条记录');
  const deletedAt = Number(meta.deletedAt) || 0;
  if (deletedAt + TRASH_RETENTION_MS < Date.now()) {
    await purgeTrashEntry(trashId);
    throw new RequestError(410, '这条记录已超过 30 天，无法恢复');
  }
  if (meta.state !== 'done' || !Array.isArray(meta.movers) || meta.movers.length === 0) {
    throw new RequestError(409, '回收站数据不完整，无法恢复');
  }
  for (const mover of meta.movers) {
    if (!mover || typeof mover.stored !== 'string' || typeof mover.originalPath !== 'string') {
      throw new RequestError(409, '回收站数据不完整，无法恢复');
    }
    if (!(await isDirectory(path.join(trashEntryDir(trashId), mover.stored)))) {
      throw new RequestError(422, '回收站数据缺失，无法恢复');
    }
    if (await isDirectory(mover.originalPath)) {
      throw new RequestError(409, '原位置已存在同名会话数据，无法恢复');
    }
  }
  await forgetDeleted(ctx, meta.sessionId);
  const restored = [];
  try {
    for (const mover of meta.movers) {
      await fsp.mkdir(path.dirname(mover.originalPath), { recursive: true });
      await movePath(path.join(trashEntryDir(trashId), mover.stored), mover.originalPath);
      restored.push(mover);
    }
  } catch (error) {
    for (const mover of restored.reverse()) {
      try {
        await movePath(mover.originalPath, path.join(trashEntryDir(trashId), mover.stored));
      } catch {
        /* best-effort rollback */
      }
    }
    throw new RequestError(409, '恢复失败：' + textOf(error));
  }
  if (typeof meta.projcache === 'string' && typeof meta.projcacheName === 'string' && meta.projcacheName.endsWith('.json')) {
    await writeProjectionCache(meta.projcacheName, meta.projcache);
  }
  const registry = service(ctx, 'workspaceRegistry');
  try {
    await registry?.unarchiveSession?.(meta.sessionId);
  } catch {
    /* not archived */
  }
  try {
    await registry?.unpinSession?.(meta.sessionId);
  } catch {
    /* not pinned */
  }
  const summary = await summarizeRestored(ctx, meta);
  try {
    if (typeof ctx.emit === 'function') ctx.emit('api-session/added', summary);
  } catch (error) {
    warn('restore announcement failed', meta.sessionId, textOf(error));
  }
  try {
    await fsp.rm(trashEntryDir(trashId), { recursive: true, force: true });
  } catch (error) {
    warn('trash cleanup failed', trashId, textOf(error));
  }
  return { sessionId: meta.sessionId, title: meta.title, summary };
}

async function handleTrash(ctx, request) {
  if (request.method !== 'POST') return fail(405, '请使用 POST');
  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json' || request.headers.get(ACTION_HEADER) !== '1') {
    return fail(403, '请从设置里的回收站操作');
  }
  const denied = originVerdict(request);
  if (denied) return denied;
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return fail(error?.status || 400, textOf(error));
  }
  const action = typeof body?.action === 'string' ? body.action : '';
  try {
    if (action === 'list') {
      return json(200, { ok: true, items: await listTrash(ctx), retentionDays: 30 });
    }
    if (action === 'restore') {
      const trashId = typeof body?.trashId === 'string' ? body.trashId.trim() : '';
      if (!SAFE_TRASH_ID.test(trashId)) return fail(400, '无效的回收站 ID');
      const result = await restoreTrashEntry(ctx, trashId);
      return json(200, { ok: true, sessionId: result.sessionId, title: result.title });
    }
    if (action === 'purge') {
      const trashId = typeof body?.trashId === 'string' ? body.trashId.trim() : '';
      if (!SAFE_TRASH_ID.test(trashId)) return fail(400, '无效的回收站 ID');
      if (!(await readTrashMeta(trashId))) return fail(404, '回收站里没有这条记录');
      await purgeTrashEntry(trashId);
      return json(200, { ok: true, trashId });
    }
    if (action === 'empty') {
      const root = trashRoot();
      let names = [];
      try {
        names = await fsp.readdir(root, { withFileTypes: true });
      } catch {
        return json(200, { ok: true, purged: 0 });
      }
      let purged = 0;
      for (const entry of names) {
        if (!entry.isDirectory() || !SAFE_TRASH_ID.test(entry.name)) continue;
        try {
          await fsp.rm(trashEntryDir(entry.name), { recursive: true, force: true });
          purged += 1;
        } catch (error) {
          warn('trash empty failed', entry.name, textOf(error));
        }
      }
      return json(200, { ok: true, purged });
    }
    return fail(400, '未知操作');
  } catch (error) {
    warn('trash action failed', action, textOf(error));
    return fail(error?.status || 500, textOf(error));
  }
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
    // Delete is recoverable now: the store is moved into the recycle bin with a
    // meta record instead of being wiped, and the row is detached from the list.
    const title = typeof body?.title === 'string' ? body.title : '';
    const trashed = await moveSessionToTrash(ctx, sessionId, targets, title);
    const cleanup = await forgetInRegistry(ctx, sessionId);
    // Remember the deletion: a resident session can flush its log back to disk
    // after the move, and the sweeper removes that copy again.
    await rememberDeleted(ctx, sessionId, targets);
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
    const announced = announceRemoval(ctx, sessionId);
    return json(200, {
      ok: true,
      sessionId,
      trashed: true,
      trashId: trashed.trashId,
      expiresAt: trashed.deletedAt + TRASH_RETENTION_MS,
      removedGroups: targets.length,
      removedPaths: targets.length,
      swept,
      detached: cleanup.detached,
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
    try {
      const dispose = carrier.register({
        path: TRASH_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handleTrash(ctx, request),
      });
      if (typeof dispose?.catch === 'function') dispose.catch((error) => warn('trash route registration failed', textOf(error)));
    } catch (error) {
      warn('trash route registration failed', textOf(error));
    }
  };
  if (typeof ctx.inject === 'function') ctx.inject(['connection'], install);
  else install(ctx);
  // Startup: unarchive ghosts left by an interrupted delete, then enforce the
  // tombstones once (a resident session may have recreated its store while the
  // app was closed) and keep the sweeper running.
  try {
    const timer = setTimeout(() => {
      purgeExpiredTrash(ctx)
        .catch((error) => warn('trash expiry failed', textOf(error)))
        .then(() => loadDeleted())
        .then(() => enforceDeleted(ctx))
        .then(() => startEnforcement(ctx))
        .then(() => pruneArchivedGhosts(ctx))
        .catch((error) => warn('startup sweep failed', textOf(error)));
    }, 3000);
    timer?.unref?.();
  } catch (error) {
    warn('prune scheduling failed', textOf(error));
  }
  // The bin is fixed at 30 days; an hourly pass is enough for a foreground app.
  try {
    const timer = setInterval(() => {
      purgeExpiredTrash(ctx).catch((error) => warn('trash expiry failed', textOf(error)));
    }, 60 * 60 * 1000);
    timer?.unref?.();
  } catch (error) {
    warn('trash expiry scheduling failed', textOf(error));
  }
}
