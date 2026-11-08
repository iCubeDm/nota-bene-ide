import 'dart:io';
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/theme.dart';

/// The `:root, [data-theme="darcula"]` block of the web's theme.css, with `var(--x)` resolved.
Map<String, String> darculaTokens() {
  final css = File('../../web/src/theme.css').readAsStringSync();
  final start = css.indexOf(':root, [data-theme="darcula"]');
  final block = css.substring(start, css.indexOf('}', start));
  final raw = {
    for (final m in RegExp(r'--([a-z0-9-]+):\s*([^;]+);').allMatches(block))
      m[1]!: m[2]!.trim(),
  };
  String resolve(String v) {
    final r = RegExp(r'^var\(--([a-z0-9-]+)\)$').firstMatch(v);
    return r == null ? v : resolve(raw[r[1]!]!);
  }

  return raw.map((k, v) => MapEntry(k, resolve(v)));
}

Color parse(String v) {
  final hex = RegExp(r'^#([0-9a-f]{3}|[0-9a-f]{6})$').firstMatch(v);
  if (hex != null) {
    var h = hex[1]!;
    if (h.length == 3) h = h.split('').map((c) => '$c$c').join();
    return Color(0xff000000 | int.parse(h, radix: 16));
  }
  final rgb = RegExp(r'^rgb\((\d+) (\d+) (\d+) ?/ ?([\d.]+)\)$').firstMatch(v);
  if (rgb != null) {
    return Color.fromARGB(
      (double.parse(rgb[4]!) * 255).round(),
      int.parse(rgb[1]!),
      int.parse(rgb[2]!),
      int.parse(rgb[3]!),
    );
  }
  throw FormatException('not a colour: $v');
}

void main() {
  test('Darcula matches theme.css', () {
    final css = darculaTokens();
    final c = NbColors.darcula;
    for (final (field, token) in [
      (c.background, 'background'),
      (c.foreground, 'foreground'),
      (c.card, 'card'),
      (c.popover, 'popover'),
      (c.muted, 'muted'),
      (c.mutedFg, 'muted-fg'),
      (c.border, 'border'),
      (c.borderSoft, 'border-soft'),
      (c.primary, 'primary'),
      (c.primaryFg, 'primary-fg'),
      (c.accent, 'nb-accent'),
      (c.destructive, 'destructive'),
      (c.success, 'success'),
      (c.link, 'link'),
      (c.codeBg, 'code-bg'),
      (c.synText, 'syn-text'),
      (c.synKeyword, 'syn-keyword'),
      (c.synString, 'syn-string'),
      (c.synFunction, 'syn-function'),
      (c.synNumber, 'syn-number'),
      (c.synComment, 'syn-comment'),
      (c.synType, 'syn-type'),
      (c.synVariable, 'syn-variable'),
      (c.synProperty, 'syn-property'),
      (c.synTag, 'syn-tag'),
      (c.synAdd, 'syn-add'),
      (c.synAddBg, 'syn-add-bg'),
      (c.synDel, 'syn-del'),
      (c.synDelBg, 'syn-del-bg'),
    ]) {
      expect(field, parse(css[token]!), reason: '--$token');
    }
  });

  test('the theme carries the tokens', () {
    final t = darcula();
    expect(t.brightness, Brightness.dark);
    expect(t.extension<NbColors>(), NbColors.darcula);
    expect(t.scaffoldBackgroundColor, NbColors.darcula.background);
  });
}
