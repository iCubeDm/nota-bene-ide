// The app's quick labels and comment-batch strings, from the web's own sources (web/src/comments/labels.ts and
// web/src/i18n), so the phone sends the batch the desktop would. Written by `npm run gen:protocol`.
import { ALL_MODES } from '../../shared/src/protocol.ts';
import { QUICK_LABELS } from '../../web/src/comments/labels.ts';
import { de } from '../../web/src/i18n/de.ts';
import { en } from '../../web/src/i18n/en.ts';
import { es } from '../../web/src/i18n/es.ts';
import { ptBR } from '../../web/src/i18n/pt-BR.ts';
import { ru } from '../../web/src/i18n/ru.ts';
import { zhCN } from '../../web/src/i18n/zh-CN.ts';

export const STRINGS_PATH = 'mobile/app/lib/comments/strings.g.dart';

/** the app's language codes (its ARB files) to the web's dictionaries */
const DICTS: [string, Record<string, unknown>][] = [['en', en], ['ru', ru], ['zh', zhCN], ['es', es], ['pt', ptBR], ['de', de]];
/** the batch strings the phone's composeBatch uses */
const BATCH_KEYS = ['batchHead', 'srcChat', 'markStale'] as const;
/**
 * Web strings the phone shows as they are; `webString` reads them: the usage meters' words, the window sheet's
 * mode names and descriptions (every provider's modes, as ModePill.tsx shows them) and its clear/compact texts.
 * A key that is not a plain string in a dictionary fails the generator.
 */
export const WEB_KEYS: readonly string[] = [
  'h5', 'week',
  ...ALL_MODES.flatMap((m) => [`mode_${m}`, `mode_${m}_desc`]),
  'modeTip', 'clearTitle', 'clearQ', 'clearBtn', 'compactTip', 'clearTip', 'clearFail', 'working', 'offline',
  'srcMine', 'replyPlain',
];
/**
 * The batch's functions, as templates: each is called with the placeholders `{0}`, `{1}` for its arguments (a list
 * argument as a one-item list: every one of them joins its list with ', ', which the phone does before filling it in).
 * The key's value is the argument kinds.
 */
const TEMPLATE_KEYS: Record<string, ('n' | 'list')[]> = {
  imgLabel: ['n'], imgLabelC: ['n', 'n'], imgRef: ['list'], imgRefMedia: ['list'], filesLine: ['list'], scaledSfx: ['n'],
  srcTool: ['n', 'n'], srcAgentReply: ['n'], srcAgentTool: ['n', 'n'],
};
/**
 * The forms of the source names that drop a part when it is empty (a tool with no argument, a subagent with no name),
 * as templates of the remaining argument: key → [the function, its arguments with '' where the part is empty].
 */
const BARE_KEYS: Record<string, [string, string[]]> = {
  srcToolBare: ['srcTool', ['{0}', '']],
  srcAgentReplyBare: ['srcAgentReply', ['']],
  srcAgentToolBare: ['srcAgentTool', ['{0}', '']],
};
const bare = (d: Record<string, unknown>, key: string, args: string[]): string => {
  const f = d[key];
  if (typeof f !== 'function') throw new Error(`web i18n: ${key} is not a function`);
  const out = (f as (...a: string[]) => unknown)(...args);
  if (typeof out !== 'string') throw new Error(`web i18n: ${key} does not template`);
  return out;
};

const template = (d: Record<string, unknown>, key: string, kinds: ('n' | 'list')[]): string => {
  const f = d[key];
  if (typeof f !== 'function') throw new Error(`web i18n: ${key} is not a function`);
  const out = (f as (...a: unknown[]) => unknown)(...kinds.map((k, i) => (k === 'list' ? [`{${i}}`] : `{${i}}`)));
  if (typeof out !== 'string' || kinds.some((_, i) => !out.includes(`{${i}}`))) throw new Error(`web i18n: ${key} does not template`);
  return out;
};

/** The usage screen's words: every `usage*` key of en.ts, a function one as a template of its arity. */
const USAGE_KEYS = Object.keys(en).filter((k) => k.startsWith('usage')).sort();

const text = (d: Record<string, unknown>, key: string): string => {
  const v = d[key];
  if (typeof v !== 'string') throw new Error(`web i18n: ${key} is not a string`);
  return v;
};

/** The data as one JSON string, which dart format leaves as written (the generated file must stay formatted). */
export function mobileStrings(): string {
  const data = {
    labels: QUICK_LABELS.map((l) => ({
      id: l.id, emoji: l.emoji, ...(l.instruction ? { instruction: l.instruction } : {}),
      text: Object.fromEntries(DICTS.map(([lang, d]) => [lang, text(d, `label_${l.id}`)])),
    })),
    usage: Object.fromEntries(USAGE_KEYS.map((k) => {
      const arity = (en as Record<string, unknown>)[k] instanceof Function ? ((en as Record<string, unknown>)[k] as { length: number }).length : 0;
      return [k, Object.fromEntries(DICTS.map(([lang, d]) => [lang, arity ? template(d, k, Array(arity).fill('n')) : text(d, k)]))];
    })),
    web: Object.fromEntries(WEB_KEYS.map((k) => [k, Object.fromEntries(DICTS.map(([lang, d]) => [lang, text(d, k)]))])),
    batch: Object.fromEntries([
      ...BATCH_KEYS.map((k) => [k, Object.fromEntries(DICTS.map(([lang, d]) => [lang, text(d, k)]))]),
      ...Object.entries(TEMPLATE_KEYS).map(([k, kinds]) => [k, Object.fromEntries(DICTS.map(([lang, d]) => [lang, template(d, k, kinds)]))]),
      ...Object.entries(BARE_KEYS).map(([k, [fn, args]]) => [k, Object.fromEntries(DICTS.map(([lang, d]) => [lang, bare(d, fn, args)]))]),
    ]),
  };
  const json = JSON.stringify(data, null, 1);
  if (json.includes("'''")) throw new Error('web strings: three quotes in a row');
  return `// GENERATED by \`npm run gen:protocol\` from web/src/comments/labels.ts and web/src/i18n. Do not edit.
import 'dart:convert';

import 'package:nb_protocol/nb_protocol.dart';

class QuickLabel {
  QuickLabel._(Map<String, Object?> j)
    : id = QuickLabelId.fromJson(j['id']),
      emoji = j['emoji'] as String,
      instruction = j['instruction'] as String?,
      text = (j['text'] as Map).cast<String, String>();

  final QuickLabelId id;
  final String emoji;

  /// sent to the agent, always English
  final String? instruction;

  /// the label's text by app language
  final Map<String, String> text;

  String textIn(String lang) => text[lang] ?? text['en']!;
}

final _data = jsonDecode(_json) as Map<String, Object?>;

/// In display order, as on the desktop.
final quickLabels = [
  for (final l in _data['labels'] as List)
    QuickLabel._((l as Map).cast<String, Object?>()),
];

/// A string of the comment batch in [lang] (an app language code), English for any other.
String batchString(String key, String lang) {
  final m = ((_data['batch'] as Map)[key] as Map).cast<String, String>();
  return m[lang] ?? m['en']!;
}

/// A string of the web's own dictionary in [lang], English for any other.
String webString(String key, String lang) {
  final m = ((_data['web'] as Map)[key] as Map).cast<String, String>();
  return m[lang] ?? m['en']!;
}

/// A batch function's text in [lang] with [args] in its places (a list argument already joined with ', ').
String batchTemplate(String key, String lang, List<Object> args) =>
    _fill(batchString(key, lang), args);

/// A usage word of the web's Usage tab in [lang], English for any other.
String usageString(String key, String lang) {
  final m = ((_data['usage'] as Map)[key] as Map).cast<String, String>();
  return m[lang] ?? m['en']!;
}

/// A usage function's text in [lang] with [args] in its places.
String usageTemplate(String key, String lang, List<Object> args) =>
    _fill(usageString(key, lang), args);

/// One pass: an argument that itself holds a {1} is not filled again.
String _fill(String s, List<Object> args) => s.replaceAllMapped(
  RegExp(r'\\{(\\d+)\\}'),
  (m) => '\${args[int.parse(m[1]!)]}',
);

const _json = r'''
${json}
''';
`;
}
