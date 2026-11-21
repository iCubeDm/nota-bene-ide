import { useEffect } from 'react';
import { LANGS, routes, useAppDispatch, useFeature, useResource, useSettings, useT, dictationLangSet, type SettingsSection } from '@/sdk';
import { Button, SettingsFail, SettingsRow } from '@/sdk/ui';
import { dictationChanged, dictationResource } from './dictation.ts';
import { langName } from './lang.ts';

/** Settings → Dictation: the optional Whisper install, switched on and off, its spoken language. */
function Dictation({ active }: { active: boolean }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const { post, ask } = useSettings();
  const detect = useFeature('voiceDetect');
  // an install runs on the server with nobody awaiting it: its phase is polled until it settles
  const dict = useResource(dictationResource, undefined, { on: active, every: (now) => (now.data?.phase === 'installing' ? 2000 : 0) });
  const dictPost = async (url: string, body: unknown = {}) => {
    if (await post(url, body)) dictationChanged(dispatch, url, body);
    dict.refresh();
  };
  const d = dict.data;
  const lang = d?.dictationLang ?? 'auto';
  // the sends read the store, which hello and our own POST set: a choice another window made reaches it here
  useEffect(() => { if (d?.dictationLang) dispatch(dictationLangSet(d.dictationLang)); }, [d?.dictationLang, dispatch]);
  return (
    <>
      <SettingsFail error={dict.failed ? dict.error : null} />
      {d?.phase === 'none' && (
        <Button type="button" variant="outline" size="sm"
          onClick={() => ask({ title: t('dictInstall', d.downloadMb, d.diskMb), body: t('dictInstallQ', d.downloadMb, d.diskMb, d.dir), confirm: t('dictInstallGo'), run: () => dictPost(routes.dictation('install')) })}>
          {t('dictInstall', d.downloadMb, d.diskMb)}
        </Button>
      )}
      {d?.phase === 'installing' && <div role="status" className="text-[0.8125rem] text-muted-foreground"><span aria-hidden className="mr-1.5 inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />{t('dictInstalling')}</div>}
      {d?.phase === 'failed' && (
        <div className="flex items-center gap-3">
          <span role="alert" className="text-[0.8125rem] text-warn">{t('dictFailed')}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void dictPost(routes.dictation('install'))}>{t('dictRetry')}</Button>
        </div>
      )}
      {d?.phase === 'ready' && (
        <div className="flex flex-wrap items-center gap-4 text-[0.8125rem]">
          <label className="flex items-center gap-2 text-foreground">
            <input type="checkbox" aria-label={t('dictUse')} checked={d.on} className="size-3.5 accent-primary"
              onChange={(e) => void dictPost(routes.dictation('on'), { on: e.target.checked })} />
            {t('dictUse')}
          </label>
          <Button type="button" variant="outline" size="sm"
            onClick={() => ask({ title: t('dictRemove'), body: t('dictRemoveQ', d.dir), confirm: t('dictRemoveGo'), run: () => dictPost(routes.dictation('remove')) })}>
            {t('dictRemove')}
          </Button>
        </div>
      )}
      {d?.phase === 'ready' && detect && (
        <SettingsRow label={t('dictLang')}>
          <select aria-label={t('dictLang')} value={lang} onChange={(e) => void dictPost(routes.dictation('lang'), { lang: e.target.value })}
            className="rounded-md border border-border-soft bg-transparent px-2 py-1 text-[0.8125rem] text-foreground">
            <option value="auto">{t('dictLangAuto')}</option>
            {LANGS.map((l) => <option key={l.id} value={l.id.split('-')[0]}>{l.name}</option>)}
            {lang !== 'auto' && !LANGS.some((l) => l.id.split('-')[0] === lang) && <option value={lang}>{langName(lang)}</option>}
          </select>
          {lang === 'auto' && <div className="mt-1 text-xs text-muted-foreground">{t('dictLangAutoHint')}</div>}
        </SettingsRow>
      )}
    </>
  );
}

/** the mic's prompt brings this section into view by its element id, `settings-dictation` */
export const voiceSettings: SettingsSection[] = [{ id: 'dictation', order: 30, title: 'setDictation', render: Dictation }];
