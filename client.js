/**
 * dsh-conversation-manager — browser half (distributed as-is, no build step).
 *
 * Adds one red row to a session's "..." menu, right after "Copy Session ID":
 * clicking it deletes the conversation for good (host half: index.js).
 */
window.__ModuleLoader__.load({
  id: 'dsh-conversation-manager',
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
    };

    const dictionaries = {
      zh: FALLBACK,
      en: {
        'menu.delete': 'Delete conversation',
        'menu.busy': 'Deleting…',
        'menu.done': 'Deleted',
        'menu.retry': 'Delete failed, click to retry',
        'error.empty': 'No response from the host. Try again.',
      },
    };

    // How long the sidebar gets to drop the row by itself (Host pushes the new
    // workspace snapshot) before falling back to a full page reload.
    const LIVE_UPDATE_GRACE_MS = 1600;

    // v1 removal choreography (milliseconds): a strike line sweeps left→right over
    // the Session title, the row rests a beat, then grays out, sinks, and flies off
    // to the left. Deliberately slow: the whole exit is meant to be watched.
    const STRIKE_MS = 650;
    const HOLD_MS = 160;
    const SINK_MS = 420;
    const REST_MS = 200;
    const FLY_MS = 640;
    const REMOVAL_MS = STRIKE_MS + HOLD_MS + SINK_MS + REST_MS + FLY_MS;
    const OWN_ROW_SELECTOR = '[data-dsh-conversation-manager="delete"]';

    /** Is this element shaped like one Session row of the sidebar list? */
    function looksLikeSessionRow(element) {
      if (!element || element.querySelector(OWN_ROW_SELECTOR)) return false;
      const rect = element.getBoundingClientRect();
      return rect.height >= 22 && rect.height <= 64 && rect.width >= 140;
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
      if (!title || typeof row.querySelectorAll !== 'function') return null;
      const nodes = row.querySelectorAll('span, div, p, a, button');
      let exact = null;
      let containing = null;
      for (const node of nodes) {
        if (node === row) continue;
        if (node.children && node.children.length > 0) continue;
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (text === title) exact = node;
        else if (!containing && text.indexOf(title) !== -1) containing = node;
      }
      return exact || containing;
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
              line.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
                duration: STRIKE_MS,
                easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
                fill: 'forwards',
              }),
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
                  { filter: 'grayscale(1)', transform: 'translate3d(0, 9px, 0) scale(0.985)', opacity: 1, offset: sinkEnd },
                  { filter: 'grayscale(1)', transform: 'translate3d(0, 10px, 0) scale(0.985)', opacity: 0.98, offset: restEnd },
                  { filter: 'grayscale(1)', transform: 'translate3d(-120%, 18px, 0) scale(0.96)', opacity: 0, offset: 1 },
                ],
                {
                  duration: exitTotal,
                  delay: STRIKE_MS + HOLD_MS,
                  easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
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

    const styles = {
      button: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        boxSizing: 'border-box',
        width: '100%',
        minHeight: 30,
        margin: 0,
        padding: '0 10px',
        border: 0,
        borderRadius: 6,
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary, #e5484d)',
        font: 'inherit',
        fontSize: 13,
        lineHeight: '18px',
        textAlign: 'left',
        cursor: 'pointer',
        outline: 'none',
        whiteSpace: 'nowrap',
      },
      icon: { width: 16, height: 16, flex: '0 0 auto', display: 'block' },
      label: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    };

    function trashIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
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
          const row = findSessionRow(title);
          const effect = row ? startRemovalAnimation(row, title) : null;
          // Clear the menu once the strike has landed, so the exit animation is not
          // hidden behind the popup.
          if (effect) window.setTimeout(dismissMenu, STRIKE_MS);
          else dismissMenu();
          try {
            if (effect) await effect.done;
            const response = await fetch(new URL(ROUTE, document.baseURI), {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json', [ACTION_HEADER]: '1' },
              body: JSON.stringify({
                sessionId,
                title: typeof props.displayTitle === 'string' ? props.displayTitle : '',
              }),
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
            setPhase('done');
            dismissMenu();
          } catch (error) {
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
        trashIcon(),
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
      },
    };
  },
});
