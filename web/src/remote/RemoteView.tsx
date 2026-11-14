import { useEffect, useState, type ReactNode } from 'react';
import type { RemoteDevice } from '@nota-bene/shared';
import { Button } from '@/components/ui/button.tsx';
import { getLang, useT } from '@/i18n/index.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { cancelPair, revokePhone, saveRemote, startPair, type PairCode } from './api.ts';
import { clearPair, indicator, selectRemote, type Indicator } from './slice.ts';

/** The guide's remote-access section (how to run a relay). */
export const REMOTE_GUIDE_URL = 'https://github.com/iCubeDm/nota-bene-ide/blob/main/docs/guide.md#remote-access';

const STATE_WORD = { off: 'remoteStateOff', connecting: 'remoteStateConnecting', online: 'remoteStateOnline', trouble: 'remoteStateTrouble' } as const satisfies Record<Indicator, string>;
const STATE_TONE: Record<Indicator, string> = { off: 'text-muted-foreground', connecting: 'text-warn', online: 'text-success', trouble: 'text-destructive' };

function Section({ title, children, id }: { title: string; children: ReactNode; id: string }) {
  return (
    <section id={id} className="nb-card nb-prose px-6 py-5">
      <h2 className="mb-3 text-[0.9375rem] font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

const Row = ({ label, children }: { label: ReactNode; children: ReactNode }) => (
  <div className="flex items-baseline gap-4 py-1.5 text-[0.8125rem]">
    <div className="w-44 flex-none text-muted-foreground">{label}</div>
    <div className="min-w-0 flex-1 break-words text-foreground">{children}</div>
  </div>
);

const input = 'w-full max-w-md rounded-md border border-border-soft bg-transparent px-2 py-1 font-mono text-[0.8125rem] text-foreground';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The relay address: shown with Edit, or a field with Save (and Cancel when there is one to go back to). */
function RelayField({ relay, onSaved }: { relay: string | null; onSaved: (stoppedHand: boolean) => void }) {
  const t = useT();
  const [editing, setEditing] = useState(relay === null);
  const [value, setValue] = useState(relay ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (relay === null) setEditing(true); }, [relay]);
  if (!editing) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span id="remoteRelay" className="font-mono">{relay}</span>
        <Button type="button" variant="ghost" size="xs" onClick={() => { setValue(relay ?? ''); setError(null); setEditing(true); }}>{t('remoteEdit')}</Button>
      </span>
    );
  }
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await saveRemote({ relay: value.trim() });
      setEditing(false);
      onSaved(r.stopped === 'hand');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="flex flex-col gap-1.5" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <span className="flex flex-wrap items-center gap-2">
        <input id="remoteRelayInput" aria-label={t('remoteRelay')} value={value} placeholder="wss://relay.example.com" spellCheck={false}
          onChange={(e) => setValue(e.target.value)} className={input} />
        <Button type="submit" size="sm" disabled={busy || !value.trim()}>{t('remoteSave')}</Button>
        {relay !== null && <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>{t('remoteCancel')}</Button>}
      </span>
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </form>
  );
}

function Pairing({ ready }: { ready: boolean }) {
  const t = useT();
  const d = useAppDispatch();
  const { state, pair } = useAppSelector(selectRemote);
  const [code, setCode] = useState<PairCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!code) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [code]);
  // the code is over: paired, expired or withdrawn (a refusal keeps it, the outcome line says who was refused)
  useEffect(() => { if (pair && pair.result !== 'refused') setCode(null); }, [pair]);
  const start = async () => {
    setError(null);
    d(clearPair());
    try {
      setCode(await startPair());
      setCopied(false);
      setNow(Date.now());
    } catch (e) {
      setError(errText(e));
    }
  };
  const cancel = () => {
    setCode(null);
    d(clearPair());
    void cancelPair().catch(() => {});
  };
  const outcome = pair && (
    <div id="remotePairOutcome" role="status" className={`text-[0.8125rem] ${pair.result === 'paired' ? 'text-success' : 'text-warn'}`}>
      {pair.result === 'paired' ? t('remotePaired', pair.device?.name ?? t('remoteAPhone'), pair.device?.fingerprint ?? '')
        : pair.result === 'refused' ? t('remoteRefused', pair.fingerprint ?? '')
          : pair.result === 'expired' ? t('remoteExpired') : t('remoteCancelled')}
    </div>
  );
  if (code) {
    const min = Math.max(0, Math.ceil((code.expiresAt - now) / 60_000));
    return (
      <div className="flex flex-col gap-3">
        {/* the server's SVG of the code (uqr): nothing of the page goes into it */}
        <div id="remoteQr" className="w-56 overflow-hidden rounded-md [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: code.qr }} />
        <div className="flex flex-wrap items-center gap-2">
          <code id="remoteUri" className="max-w-md truncate text-[0.6875rem]">{code.uri}</code>
          <Button type="button" variant="outline" size="xs" onClick={() => void navigator.clipboard?.writeText(code.uri).then(() => setCopied(true), () => {})}>
            {copied ? t('remoteCopied') : t('remoteCopy')}
          </Button>
        </div>
        <div className="text-[0.8125rem] text-foreground">{t('remotePairScan', min)}</div>
        <Row label={t('remoteHostFp')}><span className="font-mono">{code.hostFingerprint}</span></Row>
        <div className="text-xs text-muted-foreground">{t('remotePairMatch')}</div>
        {outcome}
        <div><Button type="button" variant="outline" size="sm" onClick={cancel}>{t('remoteCancel')}</Button></div>
      </div>
    );
  }
  if (state?.pairing && !state.pairing.mine) return <div className="text-[0.8125rem] text-muted-foreground">{t('remotePairElsewhere')}</div>;
  return (
    <div className="flex flex-col gap-2">
      {outcome}
      {!ready && <div className="text-xs text-muted-foreground">{t('remotePairNeedsOnline')}</div>}
      <div>
        <Button id="remotePairBtn" type="button" size="sm" disabled={!ready} onClick={() => void start()}>{pair ? t('remotePairAgain') : t('remotePairBtn')}</Button>
      </div>
      {error && <span role="alert" className="text-xs text-destructive">{t('remoteFailed', error)}</span>}
    </div>
  );
}

function Phone({ p }: { p: RemoteDevice }) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revoke = async () => {
    setError(null);
    try {
      const r = await revokePhone(p.id);
      if (!r.ok) setError(r.error ?? '');
      else setAsking(false);
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <div data-phone={p.id} className="rounded-lg border border-border-soft px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[0.8125rem]">
        <span className="font-semibold text-foreground">{p.name ?? t('remoteAPhone')}</span>
        <span className="font-mono text-[0.6875rem] text-muted-foreground">{p.fingerprint}</span>
        <span className={`text-[0.6875rem] ${p.online ? 'text-success' : 'text-muted-foreground'}`}>{p.online ? t('remoteOnline') : t('remoteOffline')}</span>
        {p.pairedAt > 0 && <span className="text-[0.6875rem] text-muted-foreground">{t('remotePairedAt', new Date(p.pairedAt).toLocaleDateString(getLang()))}</span>}
        <span className="flex-1" />
        {!asking && <Button type="button" variant="ghost" size="xs" onClick={() => setAsking(true)}>{t('remoteRevoke')}</Button>}
      </div>
      {asking && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.8125rem]">
          <span className="text-foreground">{t('remoteRevokeAsk')}</span>
          <Button type="button" variant="destructive" size="xs" onClick={() => void revoke()}>{t('remoteRevoke')}</Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => setAsking(false)}>{t('remoteCancel')}</Button>
        </div>
      )}
      {error !== null && <div role="alert" className="mt-1 text-xs text-destructive">{t('remoteFailed', error)}</div>}
    </div>
  );
}

/** The Remote tab: what `nota-bene remote` and its commands do, from the window. */
export function RemoteView() {
  const t = useT();
  const { supported, state } = useAppSelector(selectRemote);
  const [note, setNote] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  if (!supported) return <div className="nb-prose mx-auto mt-6 text-[0.8125rem] text-muted-foreground">{t('remoteOldServer')}</div>;
  const ind = indicator(state);
  const configured = !!state?.configured;
  const toggle = async (enabled: boolean) => {
    setSwitching(true);
    setNote(null);
    try {
      const r = await saveRemote({ enabled });
      if (r.stopped === 'hand') setNote(t('remoteHandStopped'));
    } catch (e) {
      setNote(t('remoteFailed', errText(e)));
    } finally {
      setSwitching(false);
    }
  };
  return (
    <div className="pb-8">
      {note && <div role="status" className="nb-prose mx-auto mt-4 rounded-lg border border-border-soft bg-card px-4 py-2 text-xs text-foreground">{note}</div>}
      <Section id="remoteAccess" title={t('remoteAccess')}>
        {!configured && (
          <p className="mb-3 text-[0.8125rem] text-muted-foreground">
            {t('remoteIntro')}{' '}
            <a href={REMOTE_GUIDE_URL} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">{t('remoteGuide')}</a>
          </p>
        )}
        {configured && (
          <>
            <Row label={t('remoteSwitch')}>
              <span className="flex flex-col gap-1">
                <input id="remoteSwitch" type="checkbox" aria-label={t('remoteSwitch')} checked={state.enabled} disabled={switching || state.legacy}
                  onChange={(e) => void toggle(e.target.checked)} className="size-3.5 accent-primary" />
                {state.legacy && <span id="remoteLegacy" className="text-xs text-warn">{t('remoteLegacy')}</span>}
              </span>
            </Row>
            <Row label={t('remoteAccess')}>
              <span id="remoteStateWord" data-state={ind} className={STATE_TONE[ind]}>{t(STATE_WORD[ind])}</span>
              {ind === 'trouble' && <span className="ml-2 text-xs text-muted-foreground">{state.lastError?.message ?? t('remoteNotStarted')}</span>}
            </Row>
          </>
        )}
        <Row label={t('remoteRelay')}>
          <RelayField key={state?.relay ?? ''} relay={state?.relay ?? null} onSaved={(hand) => setNote(hand ? t('remoteHandStopped') : null)} />
        </Row>
        {state?.hostFingerprint && <Row label={t('remoteHostFp')}><span className="font-mono">{state.hostFingerprint}</span></Row>}
      </Section>
      {configured && (
        <Section id="remotePair" title={t('remotePairTitle')}>
          <Pairing ready={!!state?.enabled && !!state.online} />
        </Section>
      )}
      {configured && (
        <Section id="remotePhones" title={t('remotePhones')}>
          {state?.devices.length ? (
            <div className="flex flex-col gap-2">{state.devices.map((p) => <Phone key={p.id} p={p} />)}</div>
          ) : <div className="text-xs text-muted-foreground">{t('remoteNoPhones')}</div>}
        </Section>
      )}
    </div>
  );
}
