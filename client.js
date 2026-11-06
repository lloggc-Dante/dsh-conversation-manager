/**
 * dsh-conversation-manager — browser half (distributed as-is, no build step).
 *
 * Adds one red row to a session's "..." menu, right after "Copy Session ID":
 * clicking it deletes the conversation for good (host half: index.js).
 */
window.__ModuleLoader__.load({
  id: '@logic-dante/dsh-conversation-manager',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const SLOT = 'sidebar.workspaces.session.menu.item';
    const NAMESPACE = 'conversation-manager';
    const ROUTE = 'api/conversation-manager/delete';
    const ACTION_HEADER = 'x-dsh-conversation-manager';

    const FALLBACK = {
      'menu.delete': '删除对话',
      'menu.busy': '正在删除…',
      'menu.done': '已删除',
      'menu.retry': '删除失败，点击重试',
      'error.empty': '没有收到主进程响应，请重试。',
      'multi.label': '多选',
      'multi.selected': '已选 {count} 个对话',
      'multi.none': '未选择对话',
      'multi.cancel': '取消',
      'multi.delete': '删除',
      'multi.busy': '正在删除…',
      'multi.failed': '有 {count} 个对话删除失败',
      'multi.confirm.title': '删除选中的对话？',
      'multi.confirm.body': '将永久删除 {count} 个对话及其本地记录，无法恢复。',
      'multi.confirm.cancel': '取消',
      'multi.confirm.confirm': '确认删除',
    };

    const dictionaries = {
      zh: FALLBACK,
      en: {
        'menu.delete': 'Delete conversation',
        'menu.busy': 'Deleting…',
        'menu.done': 'Deleted',
        'menu.retry': 'Delete failed, click to retry',
        'error.empty': 'No response from the host. Try again.',
        'multi.label': 'Select',
        'multi.selected': '{count} selected',
        'multi.none': 'Nothing selected',
        'multi.cancel': 'Cancel',
        'multi.delete': 'Delete',
        'multi.busy': 'Deleting…',
        'multi.failed': '{count} conversation(s) failed to delete',
        'multi.confirm.title': 'Delete the selected conversations?',
        'multi.confirm.body': 'This permanently deletes {count} conversations and their local records. It cannot be undone.',
        'multi.confirm.cancel': 'Cancel',
        'multi.confirm.confirm': 'Delete',
      },
    };

    /** Ask the Host half to delete one conversation; throws the Host's reason. */
    async function requestDelete(sessionId) {
      const response = await fetch(new URL(ROUTE, document.baseURI), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', [ACTION_HEADER]: '1' },
        body: JSON.stringify({ sessionId }),
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (!response.ok || !payload || payload.ok !== true) {
        throw new Error((payload && (payload.message || payload.error)) || `HTTP ${response.status}`);
      }
      return payload;
    }

    // How long the sidebar gets to drop the row by itself (Host pushes the new
    // workspace snapshot) before falling back to a full page reload.
    const LIVE_UPDATE_GRACE_MS = 1600;

    // v1 removal choreography (milliseconds): a strike line sweeps left→right over
    // the Session title, the row rests a beat, then grays out, sinks, and flies off
    // to the left. Deliberately slow: the whole exit is meant to be watched.
    const STRIKE_MS = 780;
    const HOLD_MS = 220;
    const SINK_MS = 540;
    const REST_MS = 260;
    const FLY_MS = 760;
    const REMOVAL_MS = STRIKE_MS + HOLD_MS + SINK_MS + REST_MS + FLY_MS;
/** Rows below a removed row glide into the freed space over this long. */
const REFLOW_MS = 420;
    const OWN_ROW_SELECTOR = '[data-dsh-conversation-manager="delete"]';

    // The Session list lives in the left sidebar column, while the conversation
    // header at the top of the page repeats the very same title text. A row is
    // therefore only accepted when it hugs the window's left edge, which is what
    // separates a sidebar row from the page header.
    const SIDEBAR_MAX_LEFT = 140;
    const SIDEBAR_MAX_WIDTH = 640;

    /** Is this element shaped like one Session row of the sidebar list? */
    function looksLikeSessionRow(element) {
      if (!element || element.querySelector(OWN_ROW_SELECTOR)) return false;
      const rect = element.getBoundingClientRect();
      if (!(rect.height >= 22 && rect.height <= 64)) return false;
      if (!(rect.width >= 140 && rect.width <= SIDEBAR_MAX_WIDTH)) return false;
      return rect.left <= SIDEBAR_MAX_LEFT;
    }

    /** Walk up from `element` to the nearest ancestor that reads as a Session row. */
    function closestSessionRow(element, displayTitle) {
      let node = element;
      for (let depth = 0; depth < 6 && node; depth += 1) {
        if (looksLikeSessionRow(node)) {
          if (!displayTitle) return node;
          const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
          if (text.indexOf(displayTitle) !== -1) return node;
        }
        node = node.parentElement;
      }
      return null;
    }

    /**
     * Locate the sidebar row this menu belongs to. The row belongs to the Host's own
     * list, so it is found from the live DOM: first through the open "..." trigger
     * (it carries aria-expanded), then by the row title itself.
     */
    function findSessionRow(displayTitle) {
      if (typeof document === 'undefined') return null;
      const title = typeof displayTitle === 'string' ? displayTitle.replace(/\s+/g, ' ').trim() : '';
      const triggers = document.querySelectorAll('[aria-expanded="true"]');
      for (const trigger of triggers) {
        const row = closestSessionRow(trigger.parentElement, title);
        if (row) return row;
      }
      if (!title) return null;
      const nodes = document.querySelectorAll('span, div, a, button, p');
      let match = null;
      for (const node of nodes) {
        if (node.children.length > 0) continue;
        if (node.querySelector(OWN_ROW_SELECTOR)) continue;
        if ((node.textContent || '').replace(/\s+/g, ' ').trim() !== title) continue;
        // Only the sidebar copy of the title counts: the page header repeats it.
        const nodeRect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
        if (nodeRect && nodeRect.left > SIDEBAR_MAX_LEFT) continue;
        match = node;
      }
      if (!match) return null;
      return closestSessionRow(match, title) || match.parentElement;
    }

    /**
     * The leaf element inside the row that renders the Session title. Rows often
     * carry a trailing relative time in the same text run, so a containing (but
     * tightest) match is accepted too.
     */
    function findTitleElement(row, displayTitle) {
      const title = typeof displayTitle === 'string' ? displayTitle.replace(/\s+/g, ' ').trim() : '';
      if (typeof row.querySelectorAll !== 'function') return null;
      const nodes = row.querySelectorAll('span, div, p, a, button');
      let exact = null;
      let containing = null;
      let longest = null;
      for (const node of nodes) {
        if (node === row) continue;
        if (node.children && node.children.length > 0) continue;
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (title && text === title) exact = node;
        else if (title && !containing && text.indexOf(title) !== -1) containing = node;
        if (!longest || text.length > longest.length) longest = { node, length: text.length };
      }
      // The menu can hand over a raw title that differs from the rendered text;
      // the longest leaf is the title in that case (the timestamp is shorter).
      return exact || containing || (longest ? longest.node : null);
    }

    /** The first text node below `element` that contains `title`. */
    function firstTextRun(element, title) {
      const stack = [element];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;
        if (node.nodeType === 3) {
          const value = node.nodeValue || '';
          const index = value.replace(/\s+/g, ' ').indexOf(title);
          if (index !== -1) return { node, index, length: title.length };
          continue;
        }
        const children = node.childNodes;
        if (children) {
          for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
        }
      }
      return null;
    }

    /**
     * Where the strike line goes: across the title text itself (a pen stroke over
     * the label), falling back to the whole row when the title cannot be measured.
     */
    function strikePlacement(row, titleElement, displayTitle) {
      if (!titleElement || typeof titleElement.getBoundingClientRect !== 'function') return null;
      const title = typeof displayTitle === 'string' ? displayTitle.replace(/\s+/g, ' ').trim() : '';
      try {
        const rowRect = row.getBoundingClientRect();
        let titleRect = null;
        // Exact text-run measurement: only the title characters get struck, even
        // when the row also renders a relative timestamp next to it.
        if (title && typeof document !== 'undefined' && typeof document.createRange === 'function') {
          const run = firstTextRun(titleElement, title);
          if (run) {
            try {
              const range = document.createRange();
              range.setStart(run.node, run.index);
              range.setEnd(run.node, run.index + run.length);
              const measured = range.getBoundingClientRect();
              if (measured && measured.width > 0) titleRect = measured;
              range.detach && range.detach();
            } catch {
              titleRect = null;
            }
          }
        }
        if (!titleRect) titleRect = titleElement.getBoundingClientRect();
        if (!titleRect || !(titleRect.width > 0) || !(titleRect.height > 0)) return null;
        return {
          left: titleRect.left - rowRect.left,
          top: titleRect.top - rowRect.top + titleRect.height / 2 - 1,
          width: titleRect.width,
        };
      } catch {
        return null;
      }
    }

    /**
     * Play the v1 removal choreography on the row itself, before the Host drops it.
     * `done` settles when the choreography finishes; `restore` puts the row back
     * when the delete turns out to have failed.
     */
    function startRemovalAnimation(row, displayTitle) {
      const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
      const reduced = Boolean(media && media.matches);
      const previous = { position: row.style.position, overflow: row.style.overflow, pointerEvents: row.style.pointerEvents };
      const animations = [];
      let line = null;
      if (!reduced) {
        try {
          row.style.position = 'relative';
          row.style.overflow = 'hidden';
          row.style.pointerEvents = 'none';
          // Strike the title text, like crossing the words out with a pen.
          const placement = strikePlacement(row, findTitleElement(row, displayTitle), displayTitle);
          line = document.createElement('span');
          line.setAttribute('aria-hidden', 'true');
          // A pen stroke leaves a little overshoot on both ends of the word.
          const overshoot = 4;
          Object.assign(line.style, {
            position: 'absolute',
            left: placement ? `${Math.max(0, placement.left - overshoot)}px` : '8px',
            top: placement ? `${placement.top}px` : '50%',
            width: placement ? `${placement.width + overshoot * 2}px` : 'calc(100% - 16px)',
            height: '2px',
            borderRadius: '2px',
            pointerEvents: 'none',
            zIndex: '3',
            background:
              'linear-gradient(90deg, rgba(229,72,77,0.35), var(--dsw-alias-state-error-primary, #e5484d) 18%, #ff8a8d)',
            boxShadow: '0 0 6px rgba(229,72,77,0.35)',
            transform: 'scaleX(0)',
            transformOrigin: 'left center',
          });
          row.appendChild(line);
          if (typeof line.animate === 'function') {
            animations.push(
              line.animate(
                [
                  { transform: 'scaleX(0)', opacity: 0.45 },
                  { transform: 'scaleX(0.6)', opacity: 1, offset: 0.62 },
                  { transform: 'scaleX(1)', opacity: 1 },
                ],
                {
                  duration: STRIKE_MS,
                  easing: 'cubic-bezier(0.87, 0, 0.13, 1)',
                  fill: 'forwards',
                },
              ),
            );
          }
          if (typeof row.animate === 'function') {
            const exitTotal = SINK_MS + REST_MS + FLY_MS;
            const sinkEnd = SINK_MS / exitTotal;
            const restEnd = (SINK_MS + REST_MS) / exitTotal;
            animations.push(
              row.animate(
                [
                  { filter: 'grayscale(0)', transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1, offset: 0 },
                  { filter: 'grayscale(0.55)', transform: 'translate3d(0, 3px, 0) scale(0.997)', opacity: 1, offset: sinkEnd * 0.55 },
                  { filter: 'grayscale(1)', transform: 'translate3d(0, 7px, 0) scale(0.992)', opacity: 0.96, offset: sinkEnd },
                  { filter: 'grayscale(1)', transform: 'translate3d(0, 8px, 0) scale(0.992)', opacity: 0.9, offset: restEnd },
                  { filter: 'grayscale(1)', transform: 'translate3d(-110%, 16px, 0) scale(0.965)', opacity: 0, offset: 1 },
                ],
                {
                  duration: exitTotal,
                  delay: STRIKE_MS + HOLD_MS,
                  easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
                  fill: 'forwards',
                },
              ),
            );
          }
        } catch {
          /* the animation is a nicety: never let it block the delete */
        }
      }
      const done = new Promise((resolve) => {
        if (reduced || animations.length === 0) {
          resolve();
          return;
        }
        window.setTimeout(resolve, REMOVAL_MS);
      });
      return {
        done,
        restore() {
          for (const animation of animations) {
            try {
              animation.cancel();
            } catch {
              /* already finished */
            }
          }
          if (line && line.parentNode) line.parentNode.removeChild(line);
          row.style.position = previous.position;
          row.style.overflow = previous.overflow;
          row.style.pointerEvents = previous.pointerEvents;
        },
      };
    }

    /**
     * Ask the slot's live Workspace snapshot whether this Session is still listed
     * anywhere (workspace rows, archive set, pin set). A boolean selector keeps the
     * subscription stable, and an unusable hook only costs us the fallback path.
     */
    function useSessionListed(props, sessionId) {
      const hook = props.useWorkspaces;
      if (typeof hook !== 'function') return false;
      try {
        return hook((snapshot) => snapshotHasSession(snapshot, sessionId)) === true;
      } catch {
        return false;
      }
    }

    /** Does the deleted Session still show up anywhere in the sidebar snapshot? */
    function snapshotHasSession(snapshot, sessionId) {
      if (!snapshot || typeof snapshot !== 'object' || typeof sessionId !== 'string') return false;
      const seen = new Set();
      const stack = [snapshot];
      let budget = 20000;
      while (stack.length > 0 && budget-- > 0) {
        const value = stack.pop();
        if (typeof value === 'string') {
          if (value === sessionId) return true;
          continue;
        }
        if (!value || typeof value !== 'object' || seen.has(value)) continue;
        seen.add(value);
        if (Array.isArray(value)) {
          for (const item of value) stack.push(item);
          continue;
        }
        if (value instanceof Map) {
          for (const [key, nested] of value) {
            if (key === sessionId) return true;
            stack.push(nested);
          }
          continue;
        }
        if (value instanceof Set) {
          for (const item of value) if (item === sessionId) return true;
          continue;
        }
        for (const key of Object.keys(value)) {
          if (key === sessionId) return true;
          stack.push(value[key]);
        }
      }
      return false;
    }

    /** Close the "..." menu from outside: the owner listens for Escape. */
    function dismissMenu() {
      try {
        const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true });
        document.dispatchEvent(event);
      } catch {
        /* no document: ignore */
      }
    }

    /* ---------------------------------------------------------------------- *
     * Multi-select: toggle beside the search box, a circle per Session row, a
     * delete bar above the account footer, and one confirmation dialog.
     * ---------------------------------------------------------------------- */

    const MULTI_CSS = `
html.dsh-cm-multi [data-row-key^="session:"] > span:first-child { position: relative; }
html.dsh-cm-multi [data-row-key^="session:"] > span:first-child > * { visibility: hidden; }
/* The ring lives in the row's leading cell, so it lines up with the folder icons. */
html.dsh-cm-multi [data-row-key^="session:"] > span:first-child::before {
  content: ""; position: absolute; left: 50%; top: 50%; width: 14px; height: 14px;
  margin: -7px 0 0 -7px; box-sizing: border-box; border: 0; border-radius: 50%; padding: 0;
  background: radial-gradient(circle 7px at 50% 50%,
    transparent 0 5.5px,
    var(--dsw-alias-label-secondary, #8a8f98) 5.6px 6.5px,
    transparent 6.6px);
  pointer-events: none; z-index: 2;
}
html.dsh-cm-multi [data-row-key^="session:"][data-dsh-cm-selected] > span:first-child::after {
  content: ""; position: absolute; left: 50%; top: 50%; width: 7px; height: 7px;
  margin: -3.5px 0 0 -3.5px; box-sizing: border-box; border-radius: 50%;
  background: radial-gradient(circle 3.5px at 50% 50%, #7AAAFF 3.3px, transparent 3.4px);
  pointer-events: none; z-index: 2;
}
html.dsh-cm-multi [data-row-key^="session:"][data-dsh-cm-selected] { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); }
/* Multi-delete collapses every removed row at once, so the list below jumps up
   in one step instead of reflowing once per Host removal. */
[data-dsh-cm-removing] { display: none !important; }

.dsh-cm-toggle {
  position: fixed; display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; box-sizing: border-box; cursor: pointer; z-index: 61;
  border: 0; border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #8a8f98);
  font: inherit; box-shadow: none; outline: none;
}
.dsh-cm-toggle:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); color: var(--dsw-alias-label-primary, #e6e6e6); }
.dsh-cm-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset: 1px; }

.dsh-cm-tooltip {
  position: fixed; z-index: 100; transform: translateX(-50%);
  background: var(--dsw-alias-tooltip-bg, #3a3a3a);
  color: var(--dsw-static-neutral-bluish-00, #ffffff);
  font: inherit; font-size: 13px; line-height: 20px;
  padding: 3px 7px; border-radius: var(--dsw-radius-sm, 6px); white-space: pre-line;
  width: max-content; max-width: min(50vw, calc(100vw - 24px)); pointer-events: none;
}

.dsh-cm-bar {
  position: fixed; display: flex; align-items: center; gap: 8px; padding: 8px 10px; box-sizing: border-box;
  z-index: 61; border: .5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l1, rgba(127,127,127,.24)));
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-overlay, #232326));
  color: var(--dsw-alias-label-primary, #e6e6e6);
  font: inherit; font-size: 12px; box-shadow: none;
}
.dsh-cm-ghost {
  border: .5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l1, rgba(127,127,127,.32)));
  background: transparent; color: inherit; font: inherit; font-size: 12px;
  padding: 5px 10px; border-radius: 8px; cursor: pointer;
}
.dsh-cm-ghost:hover { background: var(--dsw-alias-button-floating-hover, rgba(127,127,127,.12)); }
.dsh-cm-danger {
  border: 0; border-radius: 8px; padding: 5px 12px; font: inherit; font-size: 12px; font-weight: 500;
  color: #fff; background: var(--dsw-alias-state-error-primary, #e5484d); cursor: pointer;
}
.dsh-cm-danger:disabled { opacity: .5; cursor: default; }

.dsh-cm-modal-frame {
  position: fixed; inset: 0; z-index: 80; display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .38);
}
.dsh-cm-modal {
  width: 360px; max-width: calc(100vw - 48px); box-sizing: border-box; padding: 20px;
  border-radius: 16px;
  border: .5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l1, rgba(127,127,127,.2)));
  background: var(--dsw-alias-bg-overlay, #232326);
  color: var(--dsw-alias-label-primary, #e6e6e6);
  box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
  font: inherit;
}
.dsh-cm-modal-title { margin: 0 0 8px; font-size: 16px; font-weight: 600; line-height: 22px; }
.dsh-cm-modal-body { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary, #a3a3a3); }
.dsh-cm-modal-error { margin-top: 8px; font-size: 12px; color: var(--dsw-alias-state-error-primary, #e5484d); }
.dsh-cm-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.dsh-cm-modal-actions .dsh-cm-ghost, .dsh-cm-modal-actions .dsh-cm-danger { padding: 7px 14px; font-size: 13px; border-radius: 10px; }
.dsh-cm-multi-root > * { pointer-events: auto; }
`;

    function createMultiSelect() {
      let state = { active: false, selected: new Set() };
      const listeners = new Set();
      const emit = () => {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            /* a broken subscriber must not break the mode */
          }
        }
      };
      const set = (next) => {
        state = next;
        emit();
      };
      return {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        toggleActive() {
          set(state.active ? { active: false, selected: new Set() } : { active: true, selected: new Set() });
        },
        exit() {
          if (state.active) set({ active: false, selected: new Set() });
        },
        toggle(sessionId) {
          if (!state.active) return;
          const selected = new Set(state.selected);
          if (selected.has(sessionId)) selected.delete(sessionId);
          else selected.add(sessionId);
          set({ active: state.active, selected });
        },
        clearAndExit() {
          set({ active: false, selected: new Set() });
        },
      };
    }

    function useMultiState(multi) {
      const [state, setState] = React.useState(multi.get);
      React.useEffect(() => {
        setState(multi.get());
        return multi.subscribe(() => setState(multi.get()));
      }, [multi]);
      return state;
    }

    const ROW_KEY_PREFIX = 'session:';
    const rowSessionId = (element) => {
      const value = element.getAttribute('data-row-key') || '';
      return value.startsWith(ROW_KEY_PREFIX) ? value.slice(ROW_KEY_PREFIX.length) : '';
    };

    /** The sidebar row element currently showing one Session, if any. */
    function findRowElement(sessionId) {
      if (typeof document === 'undefined') return null;
      for (const row of document.querySelectorAll('[data-row-key^="session:"]')) {
        if (rowSessionId(row) === sessionId) return row;
      }
      return null;
    }

    /** The row's rendered title text (children: slot, title, status, actions). */
    function rowTitleText(row) {
      try {
        const title = row.children && row.children[1];
        return title && typeof title.textContent === 'string' ? title.textContent.replace(/\s+/g, ' ').trim() : '';
      } catch {
        return '';
      }
    }

    /** Wire the mode into the shipped row DOM: circles, click interception, Escape. */
    function installMultiSelectDom(multi) {
      if (typeof document === 'undefined') return () => {};
      let frame = 0;
      const sync = () => {
        frame = 0;
        const state = multi.get();
        document.documentElement.classList.toggle('dsh-cm-multi', state.active);
        for (const row of document.querySelectorAll('[data-row-key^="session:"]')) {
          const id = rowSessionId(row);
          if (state.active && state.selected.has(id)) row.setAttribute('data-dsh-cm-selected', '');
          else row.removeAttribute('data-dsh-cm-selected');
        }
      };
      const schedule = () => {
        if (frame) return;
        frame = window.requestAnimationFrame(sync);
      };
      const unsubscribe = multi.subscribe(schedule);
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });

      const onClick = (event) => {
        const state = multi.get();
        if (!state.active) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest('.dsh-cm-multi-root')) return;
        const row = target.closest('[data-row-key^="session:"]');
        if (!row) return;
        event.preventDefault();
        event.stopPropagation();
        multi.toggle(rowSessionId(row));
      };
      const onKeyDown = (event) => {
        const state = multi.get();
        if (!state.active) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          multi.exit();
          return;
        }
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const row = target.closest('[data-row-key^="session:"]');
        if (!row) return;
        event.preventDefault();
        event.stopPropagation();
        multi.toggle(rowSessionId(row));
      };
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKeyDown, true);
      schedule();
      return () => {
        unsubscribe();
        observer.disconnect();
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKeyDown, true);
        if (frame) window.cancelAnimationFrame(frame);
        document.documentElement.classList.remove('dsh-cm-multi');
        for (const row of document.querySelectorAll('[data-row-key^="session:"]')) row.removeAttribute('data-dsh-cm-selected');
      };
    }

    /** Locate the sidebar search input and the column around it. */
    /** The sidebar's search control, used to place the multi-select toggle. */
    function findSearchAnchor(viewportWidth, viewportHeight) {
      const inSidebar = (rect, width) =>
        rect.width >= width &&
        rect.height >= 14 &&
        rect.left >= 0 &&
        rect.left <= Math.min(480, viewportWidth * 0.5) &&
        rect.top <= viewportHeight * 0.5;
      // Primary: the search button itself. Its class name contains "search" and it
      // carries aria-expanded, so it survives layout changes around the input.
      for (const node of document.querySelectorAll('button[aria-expanded]')) {
        const className = typeof node.className === 'string' ? node.className : '';
        if (className.indexOf('search') === -1) continue;
        const rect = node.getBoundingClientRect();
        if (!inSidebar(rect, 20)) continue;
        return { element: node, rect, expanded: node.getAttribute('aria-expanded') === 'true' };
      }
      for (const node of document.querySelectorAll('[class*="searchButton"]')) {
        const rect = node.getBoundingClientRect();
        if (!inSidebar(rect, 20)) continue;
        return { element: node, rect, expanded: node.getAttribute('aria-expanded') === 'true' };
      }
      // Fallback: the collapsed input inside its search box.
      for (const input of document.querySelectorAll('input')) {
        const type = (input.getAttribute('type') || '').toLowerCase();
        if (type !== 'text' && type !== 'search') continue;
        const box = input.parentElement || input;
        const rect = box.getBoundingClientRect();
        if (!inSidebar(rect, 16)) continue;
        return { element: input, rect, expanded: rect.width > 130 };
      }
      return null;
    }

    function measureAnchors() {
      if (typeof document === 'undefined') return { toggle: null, bar: null };
      const viewportHeight = window.innerHeight || 800;
      const viewportWidth = window.innerWidth || 1200;
      const anchor = findSearchAnchor(viewportWidth, viewportHeight);
      if (!anchor) return { toggle: null, bar: null };
      const { element, rect, expanded } = anchor;
      let sidebarRect = null;
      let node = element;
      while (node && node !== document.body) {
        const candidate = node.getBoundingClientRect();
        if (candidate.left <= 12 && candidate.width >= 180 && candidate.width <= 560 && candidate.height >= viewportHeight * 0.6) {
          sidebarRect = candidate;
          break;
        }
        node = node.parentElement;
      }
      const toggleWidth = 28;
      const toggle = expanded || rect.left < 90
        ? null
        : {
            left: rect.left - toggleWidth - 4,
            top: rect.top + (rect.height - toggleWidth) / 2,
            width: toggleWidth,
            center: rect.left - toggleWidth - 4 + toggleWidth / 2,
          };
      const bar = sidebarRect
        ? { left: sidebarRect.left + 12, width: Math.max(150, sidebarRect.width - 24), bottom: 66 }
        : null;
      return { toggle, bar };
    }

    const sameAnchors = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    function multiIcon(kind) {
      // Square-check, drawn on the native 24px grid with stroke-width 1.5 so the
      // 16px rendering lands on the same ~1px optical weight as the host icons.
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M21 10.6V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.5' }),
        h('path', { d: 'm9 11 3 3L22 4' }),
      );
    }

    /**
     * Drop invisible rows out of the layout and let everything below glide up
     * into the freed space with the same slow-in/out feel as the choreography.
     * Without the FLIP step the list snaps upward in a single frame.
     */
    function collapseRowsAndReflow(removedRows) {
      if (typeof document === 'undefined') return;
      // Workspace headers move too; animate everything that changes position.
      const all = [...document.querySelectorAll('[data-row-key]')].filter(
        (node) => node.isConnected !== false,
      );
      const beforeTops = new Map();
      for (const node of all) {
        try {
          beforeTops.set(node, node.getBoundingClientRect().top);
        } catch {
          /* ignore unmeasurable rows */
        }
      }
      for (const row of removedRows) {
        if (row) row.setAttribute('data-dsh-cm-removing', '');
      }
      for (const node of all) {
        if (node.isConnected === false) continue;
        if (node.hasAttribute && node.hasAttribute('data-dsh-cm-removing')) continue;
        const before = beforeTops.get(node);
        if (before === undefined) continue;
        let delta = 0;
        try {
          delta = before - node.getBoundingClientRect().top;
        } catch {
          continue;
        }
        if (delta <= 0.5) continue;
        if (typeof node.animate !== 'function') continue;
        try {
          node.animate(
            [
              { transform: `translate3d(0, ${delta}px, 0)` },
              { transform: 'translate3d(0, 0, 0)' },
            ],
            { duration: REFLOW_MS, easing: 'cubic-bezier(0.65, 0, 0.35, 1)' },
          );
        } catch {
          /* motion is optional */
        }
      }
    }

    function MultiSelectOverlay(props) {
      const multi = props.multi;
      const translate = typeof props.translate === 'function' ? props.translate : (key) => FALLBACK[key] || key;
      const requestDelete = props.requestDelete;
      const state = useMultiState(multi);
      const [anchors, setAnchors] = React.useState(measureAnchors);
      const [confirming, setConfirming] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [errorText, setErrorText] = React.useState('');
      const [tooltip, setTooltip] = React.useState(false);
      const hoverTimer = React.useRef(0);
      React.useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
      React.useEffect(() => {
        window.clearTimeout(hoverTimer.current);
        setTooltip(false);
      }, [state.active]);

      React.useEffect(() => {
        let alive = true;
        let frame = 0;
        const update = () => {
          if (!alive) return;
          const next = measureAnchors();
          setAnchors((previous) => (sameAnchors(previous, next) ? previous : next));
        };
        const schedule = () => {
          if (frame || !alive) return;
          frame = window.requestAnimationFrame(() => {
            frame = 0;
            update();
          });
        };
        update();
        // Search expands/collapses on click, the sidebar collapses on click, and a
        // window resize moves both: refresh on the next frame instead of waiting for
        // a poll, so the toggle never floats over a changed layout.
        const timer = window.setInterval(update, 250);
        const onPointerDown = () => {
          schedule();
          window.setTimeout(update, 90);
          window.setTimeout(update, 260);
        };
        const onFocusIn = onPointerDown;
        window.addEventListener('resize', schedule);
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('focusin', onFocusIn, true);
        window.addEventListener('scroll', schedule, true);
        return () => {
          alive = false;
          window.clearInterval(timer);
          window.removeEventListener('resize', schedule);
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('focusin', onFocusIn, true);
          window.removeEventListener('scroll', schedule, true);
          if (frame) window.cancelAnimationFrame(frame);
        };
      }, []);

      const count = state.selected.size;

      const runDelete = React.useCallback(async () => {
        if (busy) return;
        const ids = [...multi.get().selected];
        if (ids.length === 0) return;
        setBusy(true);
        setErrorText('');
        // Play the same strike-out choreography on every selected row before the
        // Host is asked to delete them, so multi-delete looks like one delete.
        const effects = new Map();
        for (const id of ids) {
          const row = findRowElement(id);
          if (!row) continue;
          try {
            effects.set(id, startRemovalAnimation(row, rowTitleText(row)));
          } catch {
            /* the animation is optional */
          }
        }
        if (effects.size > 0) await new Promise((resolve) => window.setTimeout(resolve, REMOVAL_MS));
        // The rows are invisible once the choreography ends, but they still hold
        // their space. Drop them all in one step and animate the rows below into
        // the freed space, so the list glides up instead of snapping.
        const removedRows = [];
        for (const id of ids) {
          const row = findRowElement(id);
          if (row) removedRows.push(row);
        }
        if (removedRows.length > 0) collapseRowsAndReflow(removedRows);
        const failures = [];
        for (const id of ids) {
          try {
            await requestDelete(id);
          } catch (error) {
            failures.push(error && error.message ? error.message : String(error));
            const row = findRowElement(id);
            if (row) row.removeAttribute('data-dsh-cm-removing');
            const effect = effects.get(id);
            if (effect) {
              try {
                effect.restore();
              } catch {
                /* row already gone */
              }
            }
          }
        }
        setBusy(false);
        setConfirming(false);
        multi.clearAndExit();
        if (failures.length > 0) {
          try {
            window.alert(translate('multi.failed').replace('{count}', String(failures.length)) + '\n' + failures[0]);
          } catch {
            /* alert unavailable */
          }
        }
      }, [busy, multi, requestDelete, translate]);

      const children = [];
      if (!state.active && anchors.toggle) {
        children.push(
          h(
            'button',
            {
              key: 'toggle',
              type: 'button',
              className: 'dsh-cm-toggle',
              'aria-label': translate('multi.label'),
              onClick: () => {
                window.clearTimeout(hoverTimer.current);
                setTooltip(false);
                multi.toggleActive();
              },
              onMouseEnter: () => {
                window.clearTimeout(hoverTimer.current);
                hoverTimer.current = window.setTimeout(() => setTooltip(true), 400);
              },
              onMouseLeave: () => {
                window.clearTimeout(hoverTimer.current);
                setTooltip(false);
              },
              onFocus: () => setTooltip(true),
              onBlur: () => setTooltip(false),
              style: { left: anchors.toggle.left, top: anchors.toggle.top },
            },
            multiIcon('checklist'),
          ),
        );
        if (tooltip) {
          children.push(
            h(
              'div',
              {
                key: 'tooltip',
                className: 'dsh-cm-tooltip',
                role: 'tooltip',
                style: { left: anchors.toggle.center, top: anchors.toggle.top + 28 + 6 },
              },
              translate('multi.label'),
            ),
          );
        }
      }

      if (state.active && anchors.bar) {
        children.push(
          h(
            'div',
            {
              key: 'bar',
              className: 'dsh-cm-bar',
              style: { left: anchors.bar.left, width: anchors.bar.width, bottom: anchors.bar.bottom },
            },
            h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              count > 0 ? translate('multi.selected').replace('{count}', String(count)) : translate('multi.none')),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-cm-ghost',
                disabled: busy,
                onClick: () => multi.exit(),
              },
              translate('multi.cancel'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-cm-danger',
                disabled: busy || count === 0,
                onClick: () => setConfirming(true),
              },
              busy ? translate('multi.busy') : translate('multi.delete'),
            ),
          ),
        );
      }

      if (confirming) {
        children.push(
          h(
            'div',
            {
              key: 'confirm',
              className: 'dsh-cm-modal-frame',
              onClick: (event) => {
                if (event.target === event.currentTarget) setConfirming(false);
              },
            },
            h(
              'div',
              { className: 'dsh-cm-modal', role: 'dialog', 'aria-modal': 'true' },
              h('div', { className: 'dsh-cm-modal-title' }, translate('multi.confirm.title')),
              h('div', { className: 'dsh-cm-modal-body' },
                translate('multi.confirm.body').replace('{count}', String(count))),
              errorText
                ? h('div', { className: 'dsh-cm-modal-error' }, errorText)
                : null,
              h(
                'div',
                { className: 'dsh-cm-modal-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-cm-ghost',
                    disabled: busy,
                    onClick: () => setConfirming(false),
                  },
                  translate('multi.confirm.cancel'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-cm-danger',
                    disabled: busy,
                    onClick: () => runDelete(),
                  },
                  busy ? translate('multi.busy') : translate('multi.confirm.confirm'),
                ),
              ),
            ),
          ),
        );
      }

      return h(
        'div',
        { className: 'dsh-cm-multi-root', style: { position: 'fixed', inset: 0, zIndex: 60, pointerEvents: 'none' } },
        children,
      );
    }

    const styles = {
      button: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        boxSizing: 'border-box',
        width: '100%',
        minHeight: 34,
        margin: 0,
        padding: '6px 8px',
        border: 0,
        borderRadius: 10,
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary, #e5484d)',
        font: 'inherit',
        fontSize: 13,
        lineHeight: '20px',
        textAlign: 'left',
        cursor: 'pointer',
        outline: 'none',
        whiteSpace: 'nowrap',
      },
      icon: { width: 14, height: 14, flex: 'none', display: 'block' },
      iconBox: { width: 14, height: 14, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'currentColor' },
      label: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    };

    function trashIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: styles.icon,
        },
        h('path', { d: 'M2.5 4.5h11' }),
        h('path', { d: 'M6 4.5V3.2c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7v1.3' }),
        h('path', { d: 'M4.2 4.5l.6 8.1c.05.7.6 1.2 1.3 1.2h3.8c.7 0 1.25-.5 1.3-1.2l.6-8.1' }),
        h('path', { d: 'M6.6 7.2v4' }),
        h('path', { d: 'M9.4 7.2v4' }),
      );
    }

    function DeleteRow(props) {
      const translate = typeof props.translate === 'function' ? props.translate : (key) => FALLBACK[key] || key;
      const [phase, setPhase] = React.useState('idle');
      const [hover, setHover] = React.useState(false);
      const [errorText, setErrorText] = React.useState('');
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      const busy = phase === 'busy';
      const done = phase === 'done';

      // The sidebar rows come from the Host's live Workspace snapshot: after the
      // delete the row should disappear on its own. Watch it, and only fall back
      // to a full reload when that push did not happen.
      const observedListed = useSessionListed(props, sessionId);
      const sawListed = React.useRef(false);
      if (observedListed) sawListed.current = true;
      // Only an observed disappearance proves the UI already refreshed itself.
      const updatedLive = done && sawListed.current && !observedListed;

      React.useEffect(() => {
        if (!done || updatedLive) return undefined;
        const timer = window.setTimeout(() => window.location.reload(), LIVE_UPDATE_GRACE_MS);
        return () => window.clearTimeout(timer);
      }, [done, updatedLive]);

      const activate = React.useCallback(
        async (event) => {
          if (event) {
            event.preventDefault();
            event.stopPropagation();
          }
          if (busy || done) return;
          if (!sessionId) {
            setPhase('error');
            setErrorText(translate('error.empty'));
            return;
          }
          setPhase('busy');
          setErrorText('');
          // v1: play the removal choreography on the sidebar row first, then ask the
          // Host to delete. Animating in place only works while the row is still
          // mounted, so the POST waits for the effect to settle.
          const title = typeof props.displayTitle === 'string' ? props.displayTitle : '';
          // Prefer the Session id the row carries: the menu's display title can
          // differ from the rendered row text (fallback names, escaping), which
          // used to make the lookup miss and skip the animation entirely.
          const row = findRowElement(sessionId) || findSessionRow(title);
          const effect = row ? startRemovalAnimation(row, rowTitleText(row) || title) : null;
          // Clear the menu once the strike has landed, so the exit animation is not
          // hidden behind the popup.
          if (effect) window.setTimeout(dismissMenu, STRIKE_MS);
          else dismissMenu();
          try {
            if (effect) await effect.done;
            // The row is invisible now but still holds its slot. Collapse it and
            // let the rows below glide up instead of snapping into place.
            const targetRow = row || findRowElement(sessionId);
            if (targetRow) collapseRowsAndReflow([targetRow]);
            await requestDelete(sessionId);
            setPhase('done');
            dismissMenu();
          } catch (error) {
            const targetRow = row || findRowElement(sessionId);
            if (targetRow) targetRow.removeAttribute('data-dsh-cm-removing');
            if (effect) {
              try {
                effect.restore();
              } catch {
                /* row already gone */
              }
            }
            setPhase('error');
            setErrorText(error && error.message ? error.message : translate('error.empty'));
            try {
              console.warn('[conversation-manager] delete failed', error);
            } catch {
              /* console unavailable */
            }
          }
        },
        [busy, done, sessionId, props.displayTitle, translate],
      );

      const label = busy
        ? translate('menu.busy')
        : done
          ? translate('menu.done')
          : phase === 'error'
            ? translate('menu.retry')
            : translate('menu.delete');

      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          'aria-label': label,
          title: errorText || label,
          'data-dsh-conversation-manager': 'delete',
          disabled: busy || done,
          style: Object.assign({}, styles.button, {
            background: hover && !busy && !done ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14))' : 'transparent',
            cursor: busy ? 'progress' : done ? 'default' : 'pointer',
            opacity: busy ? 0.65 : 1,
          }),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onClick: activate,
        },
        h('span', { style: styles.iconBox }, trashIcon()),
        h('span', { style: styles.label }, label),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const track = (register) => {
          if (typeof ctx.effect === 'function') {
            try {
              ctx.effect(register);
              return;
            } catch {
              /* fall through to a bare call */
            }
          }
          register();
        };

        const locale = (() => {
          try {
            return ctx.locale;
          } catch {
            return undefined;
          }
        })();

        let bound;
        if (locale && typeof locale.register === 'function') {
          for (const localeId of Object.keys(dictionaries)) {
            track(() => locale.register(NAMESPACE, localeId, dictionaries[localeId]));
          }
        }
        try {
          if (locale && typeof locale.bind === 'function') bound = locale.bind(NAMESPACE);
        } catch {
          bound = undefined;
        }

        // Stable per plugin load so the row does not re-render on every locale tick.
        const translate = (key) => {
          if (typeof bound === 'function') {
            try {
              const value = bound(key);
              if (typeof value === 'string' && value.length > 0 && value !== key) return value;
            } catch {
              /* fall back to the built-in dictionary */
            }
          }
          return FALLBACK[key] || key;
        };

        const Row = (props) => h(DeleteRow, Object.assign({}, props, { translate }));

        track(() =>
          ctx.slots.inject(SLOT, () =>
            ctx.slots.register({ name: SLOT, id: 'dsh-conversation-manager.delete', order: 500 }, Row),
          ),
        );

        // Multi-select: row circles + click interception live on the document,
        // the toggle / delete bar / confirmation dialog render in the overlay.
        const multi = createMultiSelect();
        track(() => installMultiSelectDom(multi));
        track(() => {
          if (typeof document === 'undefined') return () => {};
          const style = document.createElement('style');
          style.setAttribute('data-dsh-conversation-manager', 'multi-select');
          style.textContent = MULTI_CSS;
          document.head.appendChild(style);
          return () => style.remove();
        });

        const Overlay = (props) =>
          h(MultiSelectOverlay, Object.assign({}, props, { multi, translate, requestDelete }));
        track(() =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              { name: 'shell.overlay', id: 'dsh-conversation-manager.multi-select', order: 900 },
              Overlay,
            ),
          ),
        );
      },
    };
  },
});





