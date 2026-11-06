// The interface languages. The server keeps the choice (prefs.json); the dictionaries live in web/src/i18n.

export const UI_LANGS = ['en', 'ru', 'zh-CN', 'es', 'pt-BR', 'de'] as const;
export type UiLang = (typeof UI_LANGS)[number];

export const isUiLang = (v: unknown): v is UiLang => (UI_LANGS as readonly unknown[]).includes(v);

/** The interface scales (Settings → Defaults), as a factor of the browser's font size; kept with the language, one for every window. */
export const UI_SCALES = [0.9, 1, 1.1, 1.25, 1.5] as const;
export type UiScale = (typeof UI_SCALES)[number];
export const isUiScale = (v: unknown): v is UiScale => (UI_SCALES as readonly unknown[]).includes(v);

/** The colour themes (Settings → Themes), in the order the picker lists them; kept with the language, one for every window. */
export const THEMES = ['darcula', 'plannotator'] as const;
export type ThemeId = (typeof THEMES)[number];
export const DEFAULT_THEME: ThemeId = 'darcula';
export const isThemeId = (v: unknown): v is ThemeId => (THEMES as readonly unknown[]).includes(v);
/** Whether a theme is dark or light, for the parts that must follow the browser's colour-scheme (scrollbars, diagrams, code). */
export const THEME_KIND: Record<ThemeId, 'dark' | 'light'> = { darcula: 'dark', plannotator: 'dark' };

/** The heading of a sent batch of comments, kept here because the server reads it back from transcripts too. */
export const BATCH_HEADS: Record<UiLang, string> = {
  en: 'Comments on fragments:',
  ru: 'Комментарии к фрагментам:',
  'zh-CN': '对片段的评论：',
  es: 'Comentarios sobre fragmentos:',
  'pt-BR': 'Comentários sobre trechos:',
  de: 'Kommentare zu Ausschnitten:',
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Every language's heading, so a batch sent in one language is still recognised after switching. */
export const BATCH_HEAD = new RegExp(`(?:^|\\n\\n)(?:${Object.values(BATCH_HEADS).map(esc).join('|')})\\n\\n`);
