// The app's quick labels and comment-batch strings, from the web's own sources (web/src/anchors/labels.ts and
// web/src/i18n), so the phone sends the batch the desktop would. Written by `npm run gen:protocol`.
import { ALL_MODES } from '../../shared/src/protocol.ts';
import { isDartName, memberName } from './dart.ts';
import { QUICK_LABELS } from '../../web/src/anchors/labels.ts';
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
const BATCH_KEYS = ['batchHead', 'srcChat', 'markStale', 'cutMomentQ', 'maskLine'] as const;
/**
 * Web strings the phone shows as they are; `webString` reads them: the window sheet's mode names and descriptions
 * (every provider's modes, as ModePill.tsx shows them) and its clear/compact texts, and the mic's Whisper sheet.
 * A key that is not a plain string in a dictionary fails the generator.
 */
export const WEB_KEYS: readonly string[] = [
  ...ALL_MODES.flatMap((m) => [`mode_${m}`, `mode_${m}_desc`]),
  'clearTitle', 'clearQ', 'clearBtn', 'compactTip', 'clearTip', 'clearFail', 'working', 'offline',
  'srcMine', 'replyPlain',
  'dictInstallGo', 'dictInstalling', 'dictFailed', 'dictRetry',
  // the sent comments under a message
  'commentsLc',
  // the git views' words
  'vcsChanges', 'vcsNoChanges', 'vcsNoCommits', 'vcsEmptyFile', 'vcsOnlyMeta', 'vcsTooBig', 'vcsShowAnyway', 'vcsNoRepo',
  'vcsFailed', 'binary',
  // a compaction ordered while the agent works (issue 499): the chip and the held messages
  'compactPending', 'compactPendingBody', 'compactCancel', 'youHeldRestart', 'youHeldCompact',
];
/**
 * Web strings that count (`nComments(n)`): kept as the forms of 1, 2 and 5 with the number as `{0}`, which
 * `webCount` picks from by the language's plural rule (Russian has three forms, the others two).
 */
const COUNT_KEYS = ['nComments', 'markShapes'] as const;
const counted = (d: Record<string, unknown>, key: string): Record<string, string> => {
  const f = d[key];
  if (typeof f !== 'function') throw new Error(`web i18n: ${key} is not a function`);
  const form = (n: number): string => {
    const out = (f as (n: number) => unknown)(n);
    if (typeof out !== 'string' || !out.includes(String(n))) throw new Error(`web i18n: ${key} does not count`);
    return out.replace(String(n), '{0}');
  };
  return { f1: form(1), f2: form(2), f5: form(5) };
};
/**
 * The batch's functions, as templates: each is called with the placeholders `{0}`, `{1}` for its arguments (a list
 * argument as a one-item list: every one of them joins its list with ', ', which the phone does before filling it in).
 * The key's value is the argument kinds.
 */
const TEMPLATE_KEYS: Record<string, ('n' | 'list')[]> = {
  imgLabel: ['n'], imgLabelC: ['n', 'n'], imgRef: ['list'], imgRefMedia: ['list'], filesLine: ['list'], scaledSfx: ['n'],
  srcTool: ['n', 'n'], srcAgentReply: ['n'], srcAgentTool: ['n', 'n'],
  // a comment on an edit's timeline (issue 430): the card shows it as text
  srcCut: ['n', 'n'], cutClipQ: ['n', 'n', 'n', 'n'], cutClipPhotoQ: ['n', 'n', 'n'],
  // the mic's Whisper sheet (Settings → Dictation's question): sizes and the folder
  dictInstallQ: ['n', 'n', 'n'],
  // the git views: a large diff, the base line of the changes
  vcsBigDiff: ['n'], vcsAgainst: ['n'], vcsOnlyUncommitted: ['n'], vcsLogCut: ['n'],
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

/**
 * a Dart enum of [keys], one line when it fits (as dart format writes it). A key is looked up by its member's `name`, so
 * one that cannot be a member as it is (a reserved word, `name`, a dash) fails the generator instead of being renamed.
 */
export const dartEnum = (name: string, doc: string, keys: readonly string[]): string => {
  for (const k of keys) if (!isDartName(k) || k === 'name') throw new Error(`web i18n: ${k} cannot be a member of ${name}`);
  const one = `enum ${name} { ${keys.join(', ')} }`;
  return `/// ${doc}\n${one.length <= 80 ? one : `enum ${name} {\n${keys.map((k) => `  ${k},`).join('\n')}\n}`}`;
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
    counted: Object.fromEntries(COUNT_KEYS.map((k) => [k, Object.fromEntries(DICTS.map(([lang, d]) => [lang, counted(d, k)]))])),
    batch: Object.fromEntries([
      ...BATCH_KEYS.map((k) => [k, Object.fromEntries(DICTS.map(([lang, d]) => [lang, text(d, k)]))]),
      ...Object.entries(TEMPLATE_KEYS).map(([k, kinds]) => [k, Object.fromEntries(DICTS.map(([lang, d]) => [lang, template(d, k, kinds)]))]),
      ...Object.entries(BARE_KEYS).map(([k, [fn, args]]) => [k, Object.fromEntries(DICTS.map(([lang, d]) => [lang, bare(d, fn, args)]))]),
    ]),
  };
  const json = JSON.stringify(data, null, 1);
  if (json.includes("'''")) throw new Error('web strings: three quotes in a row');
  const webKeys = WEB_KEYS.filter((k) => !k.startsWith('mode_'));
  const batchKeys = [...BATCH_KEYS, ...Object.keys(TEMPLATE_KEYS), ...Object.keys(BARE_KEYS)];
  return `// GENERATED by \`npm run gen:protocol\` from web/src/anchors/labels.ts and web/src/i18n. Do not edit.
import 'dart:convert';

import 'package:intl/intl.dart';
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

  String textIn(String lang) => text[lang] ?? text['en'] ?? '';
}

final _data = jsonDecode(_json) as Map<String, Object?>;

/// In display order, as on the desktop.
final quickLabels = [
  for (final l in _data['labels'] as List)
    QuickLabel._((l as Map).cast<String, Object?>()),
];

${dartEnum('BatchKey', 'The comment batch\'s strings ([batchString]) and functions ([batchTemplate]).', batchKeys)}

${dartEnum('WebKey', 'The web\'s own strings the app shows as they are ([webString]).', webKeys)}

${dartEnum('CountKey', 'The web\'s counted strings ([webCount]).', [...COUNT_KEYS])}

${dartEnum('UsageKey', 'The words of the web\'s Usage tab ([usageString], [usageTemplate]).', USAGE_KEYS)}

/// A string of the comment batch in [lang] (an app language code), English for any other.
String batchString(BatchKey key, String lang) => _pick('batch', key.name, lang);

/// A string of the web's own dictionary in [lang], English for any other.
String webString(WebKey key, String lang) => _pick('web', key.name, lang);

/// A mode's name as the web's mode pill shows it (ModePill.tsx); empty for a mode this app does not know.
String modeLabel(AgentMode m, String lang) => _mode(m, '', lang);

/// A mode's description, as the web's mode pill shows it.
String modeDescription(AgentMode m, String lang) => _mode(m, '_desc', lang);

String _mode(AgentMode m, String suffix, String lang) {
  final id = _modeId(m);
  return id == null ? '' : _pick('web', 'mode_$id$suffix', lang);
}

String? _modeId(AgentMode m) => switch (m) {
${ALL_MODES.map((m) => `  AgentMode.${memberName(m)} => '${m}',`).join('\n')}
  AgentMode.$unknown => null,
};

/// A counted string of the web ("3 comments") in [lang] for [n], by the web's plural rule: Intl's for Russian, one
/// or more for the others.
String webCount(CountKey key, String lang, int n) {
  final byLang = (_data['counted'] as Map)[key.name] as Map?;
  final forms = (byLang?[lang] ?? byLang?['en']) as Map?;
  if (forms == null) return '$n';
  final form = lang == 'ru'
      ? Intl.plural(n, locale: 'ru', one: 'f1', few: 'f2', other: 'f5')
      : (n == 1 ? 'f1' : 'f2');
  return _fill(forms[form] as String, [n]);
}

/// A batch function's text in [lang] with [args] in its places (a list argument already joined with ', ').
String batchTemplate(BatchKey key, String lang, List<Object> args) =>
    _fill(batchString(key, lang), args);

/// A usage word of the web's Usage tab in [lang], English for any other.
String usageString(UsageKey key, String lang) => _pick('usage', key.name, lang);

/// A usage function's text in [lang] with [args] in its places.
String usageTemplate(UsageKey key, String lang, List<Object> args) =>
    _fill(usageString(key, lang), args);

/// [key]'s text in [lang], English for any other. The generator writes every key in every language; the key itself
/// stands in should the data ever lack one, rather than a crash.
String _pick(String family, String key, String lang) {
  final byLang = (_data[family] as Map)[key] as Map?;
  return (byLang?[lang] ?? byLang?['en'] ?? key) as String;
}

/// One pass: an argument that itself holds a {1} is not filled again.
String _fill(String s, List<Object> args) => s.replaceAllMapped(
  RegExp(r'\\{(\\d+)\\}'),
  (m) => '\${args[int.parse(m[1] ?? '0')]}',
);

const _json = r'''
${json}
''';
`;
}
