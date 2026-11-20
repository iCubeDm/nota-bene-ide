import { useEffect, useRef, useState } from 'react';
import { getLang, t as tNow, useT, selectBusy, selectSession, useAppDispatch, useAppSelector, connections, byteSize } from '@/sdk';
import { Popover, PopoverContent, PopoverTrigger, ConfirmDialog } from '@/sdk/ui';
import { selectSwitching, switchSession } from './slice.ts';
import { REFUSED, useNote } from './useNote.ts';
import { archiveSession, brief, deleteSession, renameSession } from './sessionsApi.ts';

/** GET /sessions (server/src/sessions.ts SessionsView). */
export type SessionsView = {
  current: string | null;
  root: string;
  /** `archived`: hidden by the menu's archive (the server's list) */
  sessions: { id: string; title: string; at: number; size: number; cwd: string; archived?: true }[];
};
type Item = SessionsView['sessions'][number];

/** Prototype `ago`: just now, N min ago, N h ago, then a short date. */
export const ago = (at: number, now = Date.now()): string => {
  const m = Math.round((now - at) / 60000);
  return m < 1 ? tNow('justNow') : m < 60 ? tNow('minAgo', m) : m < 1440 ? tNow('hAgo', Math.round(m / 60))
    : new Date(at).toLocaleDateString(getLang(), { day: 'numeric', month: 'short' });
};

const matches = (x: Item, needle: string) => !needle || x.title.toLowerCase().includes(needle);

/**
 * What the menu shows: this project's sessions only (another project is the project switcher's), the ones not archived that
 * match `needle`, and the archived ones that match, apart. The open session is never in the archive: one opened from there
 * stays in the list while it is open.
 */
export function menuItems(v: SessionsView, needle: string): { items: Item[]; archived: Item[] } {
  const here = v.sessions.filter((x) => x.cwd === v.root && matches(x, needle));
  const hidden = (x: Item) => !!x.archived && x.id !== v.current;
  return { items: here.filter((x) => !hidden(x)), archived: here.filter(hidden) };
}

/** The session with its archive mark set or cleared. */
const marked = (x: Item, on: boolean): Item => {
  const { archived: _, ...rest } = x;
  return on ? { ...rest, archived: true } : rest;
};

const isView = (v: unknown): v is SessionsView => {
  const o = v as SessionsView;
  return !!o && typeof o.root === 'string' && Array.isArray(o.sessions);
};

type Ask = { id: string | null; title: string; dir: string };


const ROW_ACTION = 'rounded px-1 text-xs text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100';

/**
 * The Sessions menu, from ▾ on the chat tab (claude --resume): this project's sessions, to open, rename, archive or delete. Picking one asks,
 * then sends `switch`; the header says "switching…" until the new session is announced. Off while the agent works or
 * a switch runs (R-M4-4).
 */
export function SessionPicker() {
  const t = useT();
  const provider = useAppSelector((s) => s.controls.capabilities?.provider);
  const canDelete = useAppSelector((s) => !!s.controls.capabilities?.deleteSession);
  const dispatch = useAppDispatch();
  const busy = useAppSelector(selectBusy);
  const switching = useAppSelector(selectSwitching);
  const off = busy || switching;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SessionsView | string | null>(null); // string: the load failed
  const [q, setQ] = useState('');
  const [ask, setAsk] = useState<Ask | null>(null);
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  const [del, setDel] = useState<{ id: string; title: string } | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const filter = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const loadSeq = useRef(0);
  const confirmed = useRef(false);
  const [note, showNote] = useNote();
  const session = useAppSelector(selectSession);
  const needle = q.trim().toLowerCase();

  // another session or root now (another window switched, a /clear): what the menu or the question showed is stale
  const sessionKey = session ? `${session.id}\n${session.root}` : '';
  const shownFor = useRef(sessionKey);
  useEffect(() => {
    if (shownFor.current === sessionKey) return;
    shownFor.current = sessionKey;
    setOpen(false);
    setAsk(null);
    setDel(null);
  }, [sessionKey]);

  // the agent started working (another window sent) while the menu was open: nothing in it may be picked now
  useEffect(() => {
    if (off) setOpen(false);
  }, [off]);

  const onOpenChange = (o: boolean) => {
    setOpen(o);
    if (!o) return;
    setQ('');
    setView(null);
    setEdit(null);
    setShowArchive(false);
    load();
  };

  /** (Re)loads the list; the filter and the archive view stay as they are. */
  const load = () => {
    const seq = ++loadSeq.current;
    void connections.current().fetch('/sessions')
      .then(async (r) => {
        if (!r.ok) throw new Error(brief(r.status, await r.text().catch(() => '')));
        const v: unknown = await r.json();
        if (!isView(v)) throw new Error('bad /sessions answer');
        return v;
      })
      .then((v) => { if (seq === loadSeq.current) setView(v); }, (e: unknown) => {
        if (seq === loadSeq.current) setView(t('sessFail') + brief(null, e instanceof Error ? e.message : String(e)));
      });
  };
  // read when a delete answers: the agent may have started working while the question was open
  const offNow = useRef(off);
  offNow.current = off;

  const archive = async (id: string, on: boolean) => {
    const failed = await archiveSession(id, on);
    if (failed !== null) return showNote(t(on ? 'archiveFail' : 'restoreFail') + failed);
    setView((w) => (w && typeof w === 'object'
      ? { ...w, sessions: w.sessions.map((x) => (x.id === id ? marked(x, on) : x)) }
      : w));
    filter.current?.focus({ preventScroll: true });
  };

  const askDelete = (id: string, title: string) => {
    trigger.current?.focus();
    setOpen(false);
    setDel({ id, title });
  };

  const pick = (a: Ask) => {
    // focus goes back to the trigger first, so the dialog returns it there when it closes
    trigger.current?.focus();
    setOpen(false);
    setAsk(a);
  };

  const rename = async () => {
    if (!edit) return;
    const { id } = edit;
    const title = edit.text.trim();
    if (!title) return setEdit(null);
    const failed = await renameSession(id, title);
    if (failed !== null) return showNote(t('renameFail') + failed);
    setView((w) => (w && typeof w === 'object' ? { ...w, sessions: w.sessions.map((x) => (x.id === id ? { ...x, title } : x)) } : w));
    setEdit(null);
    filter.current?.focus({ preventScroll: true });
  };

  const v = typeof view === 'object' ? view : null;
  const { items, archived } = v ? menuItems(v, needle) : { items: [], archived: [] };

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            ref={trigger}
            type="button"
            id="sessBtn"
            aria-label={t('sessions')}
            disabled={off}
            // ▾ on the chat tab, which names the session: it opens the Sessions menu
            onClick={(e) => e.stopPropagation()}
            className="grid size-[18px] flex-none place-items-center rounded-[5px] text-muted-foreground hover:enabled:bg-muted hover:enabled:text-foreground disabled:cursor-default disabled:opacity-35"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
          </button>
        </PopoverTrigger>
        <PopoverContent
          aria-label={t('sessions')}
          collisionPadding={8}
          className="flex max-h-[min(70vh,560px)] w-[460px] flex-col"
          // focus the filter once the menu is positioned and shown, not while the popper still measures it
          onOpenAutoFocus={(e) => { e.preventDefault(); requestAnimationFrame(() => filter.current?.focus({ preventScroll: true })); }}
          onCloseAutoFocus={(e) => { if (ask || del) e.preventDefault(); }}
          // Esc protocol: consumed here, so the Composer does not also read it
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            if (edit) { setEdit(null); filter.current?.focus({ preventScroll: true }); return; }
            setOpen(false);
            trigger.current?.focus();
          }}
        >
          <input
            ref={filter}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('sessFilter')}
            className="m-1 flex-none rounded-md border border-border-soft bg-transparent px-2 py-1.5 text-xs text-foreground outline-none focus-visible:border-input-focus focus-visible:ring-2 focus-visible:ring-input-ring"
          />
          <div className="min-h-0 overflow-auto">
            <button
              type="button"
              data-sess-item=""
              onClick={() => v && pick({ id: null, title: '', dir: v.root })}
              disabled={!v}
              className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50"
            >
              <span data-t className="block text-[0.8125rem] text-link">{t('newHere')}</span>
            </button>
            {view === null && <div className="px-2.5 py-2 text-xs text-muted-foreground">{t('loading')}</div>}
            {typeof view === 'string' && <div className="px-2.5 py-2 text-xs text-destructive">{view}</div>}
            {items.map((x) => {
              const cur = x.id === v!.current;
              const title = x.title || t('untitled');
              if (edit?.id === x.id) {
                return (
                  <input
                    key={x.id}
                    autoFocus
                    value={edit.text}
                    maxLength={200}
                    aria-label={t('renameSess')}
                    placeholder={t('untitled')}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setEdit({ id: x.id, text: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void rename(); } }}
                    className="mx-1 my-0.5 block w-[calc(100%-0.5rem)] rounded-md border border-primary bg-transparent px-2 py-1.5 text-[0.8125rem] text-foreground outline-none"
                  />
                );
              }
              return (
                <div key={x.id} className="group/row relative">
                  <button
                    type="button"
                    data-sess-item=""
                    aria-current={cur || undefined}
                    disabled={cur}
                    onClick={() => pick({ id: x.id, title, dir: x.cwd })}
                    className={`block w-full rounded-md py-1.5 pr-16 pl-2.5 text-left hover:enabled:bg-muted ${cur ? 'cursor-default bg-primary/10' : ''}`}
                  >
                    <span data-t className="block truncate text-[0.8125rem] text-foreground">{title}</span>
                    <span className="block font-mono text-[0.65625rem] text-muted-foreground">
                      {x.id.slice(0, 8)} · {ago(x.at)} · {byteSize(x.size)}{cur ? t('openNow') : ''}
                    </span>
                  </button>
                  <div className="absolute top-1.5 right-1.5 flex gap-0.5">
                    <button
                      type="button"
                      aria-label={`${t('renameSess')}: ${title}`}
                      title={t('renameSess')}
                      onClick={() => setEdit({ id: x.id, text: x.title })}
                      className={ROW_ACTION}
                    >
                      ✎
                    </button>
                    {/* the open session can be neither archived nor deleted: switch away first */}
                    {!cur && (
                      <button type="button" aria-label={`${t('archiveSess')}: ${title}`} title={t('archiveSess')} onClick={() => void archive(x.id, true)} className={ROW_ACTION}>
                        <ArchiveIcon />
                      </button>
                    )}
                    {!cur && canDelete && (
                      <button type="button" aria-label={`${t('deleteSess')}: ${title}`} title={t('deleteSess')} onClick={() => askDelete(x.id, title)} className={`${ROW_ACTION} hover:text-destructive`}>
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {archived.length > 0 && (
              <button
                type="button"
                aria-expanded={showArchive}
                onClick={() => setShowArchive((a) => !a)}
                className="mt-1 block w-full rounded-md border-t border-border-soft px-2.5 pt-2 pb-1 text-left font-mono text-[0.65625rem] text-muted-foreground hover:text-foreground"
              >
                {showArchive ? t('hideArchive') : t('showArchive', archived.length)}
              </button>
            )}
            {/* never the open session (menuGroups) */}
            {showArchive && archived.map((x) => {
              const title = x.title || t('untitled');
              return (
                <div key={x.id} data-sess-archived="" className="group/row relative">
                  <button
                    type="button"
                    onClick={() => pick({ id: x.id, title, dir: x.cwd })}
                    className="block w-full rounded-md py-1.5 pr-24 pl-2.5 text-left opacity-70 hover:enabled:bg-muted"
                  >
                    <span className="block truncate text-[0.8125rem] text-foreground">{title}</span>
                    <span className="block truncate font-mono text-[0.65625rem] text-muted-foreground">
                      {x.id.slice(0, 8)} · {ago(x.at)} · {byteSize(x.size)}
                    </span>
                  </button>
                  <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
                    <button
                      type="button"
                      aria-label={`${t('restoreSess')}: ${title}`}
                      onClick={() => void archive(x.id, false)}
                      className="rounded px-1 text-xs text-link hover:underline"
                    >
                      {t('restoreSess')}
                    </button>
                    {canDelete && (
                      <button type="button" aria-label={`${t('deleteSess')}: ${title}`} title={t('deleteSess')} onClick={() => askDelete(x.id, title)} className={`${ROW_ACTION} hover:text-destructive`}>
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
      {note && <span role="status" className="flex-none text-[0.6875rem] text-warn">{note}</span>}
      {ask && v && (
        <ConfirmDialog
          title={ask.id ? t('openQ', ask.title) : t('newQ')}
          body={t(provider === 'codex' ? 'switchWarnCodex' : provider === 'omp' ? 'switchWarnOmp' : 'switchWarn').trim()}
          confirm={t('switchBtn')}
          onConfirm={() => {
            setAsk(null);
            const r = dispatch(switchSession(ask.id, ask.dir));
            // sent: the trigger is disabled now, so the focus goes to the composer (the draft waits there)
            confirmed.current = r === 'sent';
            if (r !== 'sent') {
              showNote(t('switchFail') + t(REFUSED[r]));
            }
          }}
          onCancel={() => { confirmed.current = false; setAsk(null); }}
          focusAfter={() => (confirmed.current ? document.getElementById('composer-input') : null)}
        />
      )}
      {del && (
        <ConfirmDialog
          title={t('deleteQ', del.title)}
          body={t('deleteWarn')}
          confirm={t('deleteBtn')}
          danger
          onConfirm={() => {
            const { id } = del;
            setDel(null);
            void deleteSession(id).then((failed) => {
              if (failed !== null) return showNote(t('deleteFail') + failed);
              setView((w) => (w && typeof w === 'object' ? { ...w, sessions: w.sessions.filter((x) => x.id !== id) } : w));
              if (offNow.current) return;
              setOpen(true); // the menu again, where it was (filter, archive view), without it
              load();
            });
          }}
          onCancel={() => setDel(null)}
        />
      )}
    </>
  );
}

/** An archive box: a lid over a box with a slot. */
export const ArchiveIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden className="inline-block align-[-1px]">
    <rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
  </svg>
);
