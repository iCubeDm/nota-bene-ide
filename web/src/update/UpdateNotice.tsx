import { useEffect, useRef, useState } from 'react';
import { useT, routes, storage, string, defineResource, useResource, usePagePause, reloadPage, connections } from '@/sdk';
import { Popover, PopoverContent, PopoverTrigger, Markdown } from '@/sdk/ui';

/** the newest version the user put off with Later */
const SEEN = storage.local<string | null>('nb.updateSeen', string, null);
/** a notice dismissed once per key: any stored value counts */
const dismissed = (key: string) => storage.local(key, { read: () => true, write: () => '1', is: (v): v is boolean => v === true }, false);
/** a plain release version (server/src/update.ts RELEASE) */
const RELEASE = /^\d+\.\d+\.\d+$/;
const RECHECK = 'nb-update-recheck';
/** how often the page asks: at rest, while the install runs, while it waits for a pause */
const ASK_MS = 60_000;
const INSTALLING_MS = 2_000;
const READY_MS = 10_000;

export const statusResource = defineResource<void, Status>({ id: 'update.status', key: () => '', route: () => routes.systemUpdate() });

type Phase = 'none' | 'available' | 'installing' | 'ready' | 'failed' | 'rolled-back';
/** the server's UpdateStatus (server/src/updater.ts) */
type Status = {
  current: string;
  latest: string | null;
  phase: Phase;
  canUpdate: boolean;
  auto: boolean;
  busy: boolean;
  log: string;
  failed?: string;
  rolledBack?: string;
  updatedFrom?: string;
  /** issue 457: the /nb Claude Code plugin version that opened this window, older than `current` */
  plugin?: string;
};

/** The switch in Settings changed: the notice follows at once, not on the next focus. */
export const recheckUpdate = () => window.dispatchEvent(new Event(RECHECK));

const post = (path: string, body?: unknown) =>
  connections.current().fetch(path, { method: 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });

const popoverStyle = 'grid w-[420px] gap-2 p-3 text-xs';
const chip = 'flex-none rounded border border-primary px-1.5 py-px font-mono text-[0.6875rem] text-link hover:bg-primary/10';
const quiet = 'rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground';
const primary = 'rounded bg-primary px-2 py-1 text-primary-foreground hover:opacity-90 disabled:opacity-50';

/** CHANGELOG is written in English: it is the project's text, not the interface's */
function Changes({ text }: { text: string }) {
  const t = useT();
  return (
    <section aria-label={t('updateChanges')} className="grid gap-1 border-t border-border-soft pt-2">
      <b className="font-semibold text-foreground">{t('updateChanges')}</b>
      <div data-testid="update-changes" className="max-h-[45vh] overflow-y-auto pr-1 [&_.md]:text-xs [&_.md_h2]:text-[0.8125rem]">
        <Markdown text={text} final noHtml />
      </div>
    </section>
  );
}

/** The Reload of a page whose code is of the version before (it was not in a pause to reload by itself). */
function Reload({ v }: { v: string }) {
  const t = useT();
  return <button type="button" id="updateReloadBtn" title={t('updateReloadTip', v)} onClick={reloadPage} className={primary}>{t('updateReload')}</button>;
}

/**
 * "Updated to 1.7.0" once per window and version, after a handover: what changed since the version before. While the
 * page still runs the code of the version before (`stale`), it stays and offers Reload.
 */
function UpdatedTo({ v, from, stale }: { v: string; from: string; stale: boolean }) {
  const t = useT();
  const key = `nb.updated.${location.port}.${v}`;
  const [gone, setGone] = useState(() => dismissed(key).get());
  const [changes, setChanges] = useState<string | null>(null);
  if (gone && !stale) return null;
  const open = (on: boolean) => {
    if (on) {
      void connections.current().fetch(routes.systemUpdateChanges(from))
        .then(async (r) => (r.ok ? ((await r.json()) as { text: string | null }).text : null))
        .then((text) => { if (text) setChanges(text); }, () => {});
    } else {
      dismissed(key).set(true);
      setGone(true);
    }
  };
  return (
    <>
      <Popover onOpenChange={open}>
        <PopoverTrigger asChild>
          <button type="button" id="updatedBtn" className={chip}>{t('updatedTo', v)}</button>
        </PopoverTrigger>
        <PopoverContent aria-label={t('updatedTo', v)} collisionPadding={8} className={popoverStyle}>
          <b className="text-[0.8125rem] font-semibold text-foreground">{t('updatedTo', v)}</b>
          {changes && <Changes text={changes} />}
        </PopoverContent>
      </Popover>
      {stale && <Reload v={v} />}
    </>
  );
}

/** issue 457: the commands that update the /nb plugin; Claude Code does not update a third-party marketplace by itself */
const PLUGIN_UPDATE = 'claude plugin marketplace update nota-bene\nclaude plugin update nota-bene@nota-bene';

/**
 * Issue 457: the window was opened by /nb from a Claude Code plugin older than the version it now runs (an in-app update
 * moved the window on, the plugin stayed). The popover gives the commands; Got it hides it until the next plugin version.
 */
function PluginOutdated({ plugin, current }: { plugin: string; current: string }) {
  const t = useT();
  const key = `nb.pluginSeen.${plugin}`;
  const [gone, setGone] = useState(() => dismissed(key).get());
  if (gone) return null;
  const dismiss = () => {
    dismissed(key).set(true);
    setGone(true);
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" id="pluginOutdatedBtn" className={chip}>{t('pluginOld')}</button>
      </PopoverTrigger>
      <PopoverContent aria-label={t('pluginOld')} collisionPadding={8} className={popoverStyle}>
        <b className="text-[0.8125rem] font-semibold text-foreground">{t('pluginOld')}</b>
        <span className="text-muted-foreground">{t('pluginOldWhy', plugin, current)}</span>
        <code className="whitespace-pre rounded bg-muted px-2 py-1 font-mono text-[0.6875rem] text-foreground select-all">{PLUGIN_UPDATE}</code>
        <span className="text-muted-foreground">{t('pluginOldRestart')}</span>
        <span className="text-muted-foreground">{t('pluginOldAuto')}</span>
        <span className="flex justify-end pt-1">
          <button type="button" onClick={dismiss} className={quiet}>{t('pluginOldDismiss')}</button>
        </span>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The header's update notice. While a newer version is on npm: "↑ 1.3.0" (Update and the automatic switch where the
 * window can update, the npm command where it cannot; Later hides it until the next version). Then "Updating to…",
 * "… is ready" (the window restarts by itself in a pause, or by Restart), "Update failed" / "was rolled back" with
 * the log, and once after a handover "Updated to …".
 */
export function UpdateNotice() {
  const t = useT();
  // the server's answer, or what this page's own install or switch just made of it (until the server says more)
  // the phase shown sets the pace; an install and a restart waiting for a pause are followed while the tab is hidden
  const [phase, setPhase] = useState<Phase | undefined>();
  const moving = phase === 'installing' || phase === 'ready';
  const got = useResource(statusResource, undefined, { every: phase === 'installing' ? INSTALLING_MS : phase === 'ready' ? READY_MS : ASK_MS, whileHidden: moving });
  // a refusal hides the notice; a network error keeps what is shown
  const server = got.failed && got.status !== undefined ? null : got.data;
  const [mine, setMine] = useState<{ over: Status | null; v: Status } | null>(null);
  const update = mine && mine.over === server ? mine.v : server;
  const setUpdate = (v: Status) => setMine({ over: server, v });
  const [seen, setSeen] = useState(() => SEEN.get());
  // what the newer version changes, by version: asked when the popover first opens for it
  const [changes, setChanges] = useState<{ v: string; text: string } | null>(null);
  // the pause the server cannot see (pagePause.ts): a draft counts, the update's reload would lose it
  const idle = usePagePause({ draft: true });
  const restartedAt = useRef(0);
  // the server version this page's code came with: another one after a reconnect means a handover happened
  const loadedWith = useRef<string | null>(null);

  if (server && loadedWith.current === null) loadedWith.current = server.current;
  const ask = got.refresh;
  // a reconnect may be to a server of another version (a handover): the repository asks at once
  useEffect(() => {
    window.addEventListener('focus', ask); // the server keeps the answer, so this asks npm no more often
    window.addEventListener(RECHECK, ask);
    return () => {
      window.removeEventListener('focus', ask);
      window.removeEventListener(RECHECK, ask);
    };
  }, [ask]);
  useEffect(() => setPhase(update?.phase), [update?.phase]);
  // the window restarts only in a pause: the server checks its turn, this page the composer and the questions
  useEffect(() => {
    if (update?.phase !== 'ready' || update.busy || !idle || Date.now() - restartedAt.current < READY_MS) return;
    restartedAt.current = Date.now();
    void post(routes.systemUpdate('restart')).catch(() => {});
  }, [update, idle]);
  // after a handover the page still runs the code of the version before: it reloads by itself in a pause (drafts are
  // not kept across a reload), otherwise Updated to offers Reload
  // (releases only: a source checkout's version changes with each commit, and its reloads stay the developer's)
  const stale = update !== null && loadedWith.current !== null && update.current !== loadedWith.current
    && RELEASE.test(update.current) && RELEASE.test(loadedWith.current);
  const serverBusy = update?.busy === true;
  useEffect(() => {
    if (stale && idle && !serverBusy) reloadPage();
  }, [stale, idle, serverBusy]);

  if (!update) return null;
  const plugin = update.plugin ? <PluginOutdated key={update.plugin} plugin={update.plugin} current={update.current} /> : null;
  const updated = (
    <>
      {plugin}
      {update.updatedFrom
        ? <UpdatedTo key={update.current} v={update.current} from={update.updatedFrom} stale={stale} />
        : stale ? <Reload v={update.current} /> : null}
    </>
  );
  const install = () => {
    void post(routes.systemUpdate('install'))
      .then(async (r) => (r.ok ? ((await r.json()) as Status) : null))
      .then((u) => { if (u) setUpdate(u); }, () => {});
  };
  const setAuto = (on: boolean) => {
    setUpdate({ ...update, auto: on });
    void post(routes.systemUpdate('auto'), { on }).catch(() => {});
  };
  const latest = update.latest ?? '';

  if (update.phase === 'installing') {
    return <>{updated}<span id="updateBtn" role="status" className={chip}>{t('updateInstalling', latest)}</span></>;
  }
  if (update.phase === 'ready') {
    return (
      <>
        {updated}
        <span id="updateBtn" className={`${chip} flex items-center gap-1.5`}>
          {t('updateReady', latest)}
          <button
            type="button"
            disabled={update.busy}
            title={update.busy ? t('updateRestartBusy') : undefined}
            onClick={() => void post(routes.systemUpdate('restart')).catch(() => {})}
            className="rounded bg-primary px-1.5 text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {t('updateRestart')}
          </button>
        </span>
      </>
    );
  }
  if (update.phase === 'failed' || update.phase === 'rolled-back') {
    const title = update.phase === 'failed' ? t('updateFailed') : t('updateRolledBack', update.rolledBack ?? latest);
    return (
      <>
        {updated}
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" id="updateBtn" className="flex-none rounded border border-warn px-1.5 py-px font-mono text-[0.6875rem] text-warn hover:bg-warn/10">{title}</button>
          </PopoverTrigger>
          <PopoverContent aria-label={title} collisionPadding={8} className={popoverStyle}>
            <b className="text-[0.8125rem] font-semibold text-foreground">{title}</b>
            <code className="rounded bg-muted px-2 py-1 font-mono text-[0.6875rem] text-foreground select-all">{t('updateLog', update.log)}</code>
            {update.canUpdate && update.latest && (
              <span className="flex justify-end pt-1">
                <button type="button" onClick={install} className={primary}>{t('updateNow')}</button>
              </span>
            )}
          </PopoverContent>
        </Popover>
      </>
    );
  }
  if (!update.latest || update.latest === seen) return updated;
  const open = (on: boolean) => {
    if (!on || changes?.v === latest) return;
    void connections.current().fetch(routes.systemUpdateChanges())
      .then(async (r) => (r.ok ? ((await r.json()) as { text: string | null }).text : null))
      .then((text) => { if (text) setChanges({ v: latest, text }); }, () => {});
  };
  const later = () => {
    SEEN.set(latest);
    setSeen(latest);
  };
  return (
    <>
      {updated}
      <Popover onOpenChange={open}>
        <PopoverTrigger asChild>
          <button type="button" id="updateBtn" title={t('updateTitle', latest)} className={chip}>
            ↑ {latest}
          </button>
        </PopoverTrigger>
        <PopoverContent aria-label={t('updateTitle', latest)} collisionPadding={8} className={popoverStyle}>
          <b className="text-[0.8125rem] font-semibold text-foreground">{t('updateTitle', latest)}</b>
          <span className="text-muted-foreground">{update.canUpdate ? t('updateRunning', update.current) : t('updateYours', update.current)}</span>
          {!update.canUpdate && (
            <>
              <code className="rounded bg-muted px-2 py-1 font-mono text-[0.6875rem] text-foreground select-all">npm i -g nota-bene-ide@{latest}</code>
              <span className="text-muted-foreground">{t('updateHow')}</span>
            </>
          )}
          {changes?.v === latest && <Changes text={changes.text} />}
          {update.canUpdate && (
            <label className="flex items-center gap-2 pt-1 text-foreground">
              <input type="checkbox" checked={update.auto} onChange={(e) => { setAuto(e.target.checked); }} className="size-3.5 accent-primary" />
              {t('updateAuto')}
            </label>
          )}
          <span className="flex items-center justify-between pt-1">
            <a
              href={`https://github.com/iCubeDm/nota-bene-ide/releases/tag/v${latest}`}
              target="_blank"
              rel="noreferrer"
              className="text-link hover:underline"
            >
              {t('updateNotes')}
            </a>
            <span className="flex items-center gap-1">
              <button type="button" onClick={later} className={quiet}>{t('updateLater')}</button>
              {update.canUpdate && <button type="button" onClick={install} className={primary}>{t('updateNow')}</button>}
            </span>
          </span>
        </PopoverContent>
      </Popover>
    </>
  );
}
