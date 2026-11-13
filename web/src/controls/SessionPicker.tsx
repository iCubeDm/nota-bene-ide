import { useEffect, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { getLang, t as tNow, useT } from '@/i18n/index.ts';
import { selectBusy, selectSession, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { selectSwitching, switchSession } from './slice.ts';
import { REFUSED, useNote } from './useNote.ts';
import { apiFetch } from '@/net/auth.ts';
import { archiveSession, brief, deleteSession, renameSession } from './sessionsApi.ts';
import { ICONS, Svg } from '@/tabs/TabStrip.tsx';
import { shortWinHome } from '@/lib/paths.ts';

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
/** Prototype `kb`: MB above 1e6 bytes, whole KB below. */
export const kb = (n: number): string => (n > 1e6 ? `${(n / 1e6).toFixed(1)} ${tNow('mb')}` : `${Math.round(n / 1e3)} ${tNow('kb')}`);
const short = (d: string) => shortWinHome(d).replace(/^\/Users\/[^/]+/, '~');

/** This project first, then the other folders in first-appearance order; empty groups are dropped. */
export function groupSessions(v: SessionsView): { dir: string; here: boolean; items: Item[] }[] {
  const groups = new Map<string, Item[]>([[v.root, []]]);
  for (const x of v.sessions) {
    if (!groups.has(x.cwd)) groups.set(x.cwd, []);
    groups.get(x.cwd)!.push(x);
  }
  return [...groups].filter(([, xs]) => xs.length).map(([dir, items]) => ({ dir, here: dir === v.root, items }));
}

const GROUPS_KEY = 'sessions:groups';
const MAX_GROUPS = 200;
/** The folder groups the user opened (true) or closed (false); absent: closed, but this project's open. */
type GroupState = Record<string, boolean>;
function readGroups(): GroupState {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, b]) => typeof b === 'boolean')) : {};
  } catch {
    return {};
  }
}
function saveGroups(g: GroupState): void {
  // the latest choices win: a key set again moves to the end
  try { localStorage.setItem(GROUPS_KEY, JSON.stringify(Object.fromEntries(Object.entries(g).slice(-MAX_GROUPS)))); } catch { /* storage unavailable: not persisted */ }
}

const matches = (x: Item, needle: string) => !needle || `${x.title} ${x.cwd}`.toLowerCase().includes(needle);

/**
 * What the menu shows: the folder groups of the sessions not archived (only the ones with a match for `needle`), each open
 * as `stored` says (this project's by default) or, with a filter, open; and the archived sessions that match, apart. The
 * open session is never in the archive: one opened from there stays in its group while it is open.
 */
export function menuGroups(v: SessionsView, needle: string, stored: GroupState) {
  const hidden = (x: Item) => !!x.archived && x.id !== v.current;
  const groups = groupSessions({ ...v, sessions: v.sessions.filter((x) => !hidden(x)) })
    .map((g) => ({ ...g, items: g.items.filter((x) => matches(x, needle)), open: needle ? true : stored[g.dir] ?? g.here }))
    .filter((g) => g.items.length);
  return { groups, archived: v.sessions.filter((x) => hidden(x) && matches(x, needle)) };
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
 * "Sessions ▾" in the header (claude --resume): every session of every folder, this project first. Picking one asks,
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
  const [stored, setStored] = useState<GroupState>(readGroups);
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
    void apiFetch('/sessions')
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

  const toggle = (dir: string, open: boolean) => {
    if (needle) return; // a filter keeps every group with a match open
    setStored((g) => {
      const { [dir]: _, ...rest } = g;
      const next = { ...rest, [dir]: !open };
      saveGroups(next);
      return next;
    });
  };

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
  const { groups, archived } = v ? menuGroups(v, needle, stored) : { groups: [], archived: [] };

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            ref={trigger}
            type="button"
            id="sessBtn"
            aria-label={t('sessions')}
            title={t(provider === 'codex' ? 'sessTipCodex' : provider === 'omp' ? 'sessTipOmp' : 'sessTip')}
            disabled={off}
            className="inline-flex flex-none items-center gap-1 rounded border border-border-soft px-2 py-px font-mono text-[0.6875rem] text-muted-foreground hover:enabled:border-primary hover:enabled:text-foreground disabled:cursor-default disabled:opacity-35 [&>svg]:text-accent-sessions"
          >
            <Svg size={14}>{ICONS.history}</Svg>
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
            {groups.map((g) => (
              <div key={g.dir}>
                <button
                  type="button"
                  data-sess-group=""
                  data-here={g.here || undefined}
                  aria-expanded={g.open}
                  title={g.dir}
                  onClick={() => toggle(g.dir, g.open)}
                  className={`flex w-full items-center rounded-md px-2.5 pt-2.5 pb-1 text-left font-mono text-[0.65625rem] hover:text-foreground ${g.here ? 'text-link' : 'text-muted-foreground'}`}
                >
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden className={`mr-1 flex-none transition-transform ${g.open ? '' : '-rotate-90'}`}><path d="m6 9 6 6 6-6" /></svg>
                  <span className="truncate">{g.here ? t('thisProject') : ''}{short(g.dir)}</span>
                  {/* the count stays in sight when a long folder is cut */}
                  <span className="flex-none">{`\u00a0· ${g.items.length}`}</span>
                </button>
                {g.open && g.items.map((x) => {
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
                          {x.id.slice(0, 8)} · {ago(x.at)} · {kb(x.size)}{cur ? t('openNow') : ''}
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
              </div>
            ))}
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
                    <span className="block truncate font-mono text-[0.65625rem] text-muted-foreground" title={x.cwd}>
                      {x.id.slice(0, 8)} · {ago(x.at)} · {short(x.cwd)}
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
          body={`${ask.dir !== v.root ? t('moveQ', ask.dir) : ''}${t(provider === 'codex' ? 'switchWarnCodex' : provider === 'omp' ? 'switchWarnOmp' : 'switchWarn')}`.trim()}
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
const ArchiveIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden className="inline-block align-[-1px]">
    <rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
  </svg>
);
