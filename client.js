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
          try {
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
