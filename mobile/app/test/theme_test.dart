import 'dart:io';
import 'dart:math' as math;
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/theme.dart';

/// One theme's token block of the web's theme.css (comments dropped), with `var(--x)` resolved.
Map<String, String> themeTokens(String id) {
  final css = File(
    '../../web/src/theme.css',
  ).readAsStringSync().replaceAll(RegExp(r'/\*.*?\*/', dotAll: true), '');
  final sel = id == 'darcula'
      ? ':root, [data-theme="darcula"]'
      : '[data-theme="$id"] {';
  final start = css.indexOf(sel);
  expect(start, isNot(-1), reason: 'no block for $id');
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

/// OKLCH to sRGB, clipped per channel like the browsers paint an out-of-gamut colour.
Color oklch(double l, double c, double h, double a) {
  final r = h * math.pi / 180, aa = c * math.cos(r), bb = c * math.sin(r);
  double cube(double x) => x * x * x;
  final lc = cube(l + 0.3963377774 * aa + 0.2158037573 * bb);
  final mc = cube(l - 0.1055613458 * aa - 0.0638541728 * bb);
  final sc = cube(l - 0.0894841775 * aa - 1.2914855480 * bb);
  int ch(double x) {
    final g = x <= 0.0031308 ? 12.92 * x : 1.055 * math.pow(x, 1 / 2.4) - 0.055;
    return (g * 255).round().clamp(0, 255);
  }

  return Color.fromARGB(
    (a * 255).round(),
    ch(4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc),
    ch(-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc),
    ch(-0.0041960863 * lc - 0.7034186147 * mc + 1.7076147010 * sc),
  );
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
  final ok = RegExp(
    r'^oklch\(([\d.]+) ([\d.]+) ([\d.]+)(?: ?/ ?([\d.]+))?\)$',
  ).firstMatch(v);
  if (ok != null) {
    return oklch(
      double.parse(ok[1]!),
      double.parse(ok[2]!),
      double.parse(ok[3]!),
      double.parse(ok[4] ?? '1'),
    );
  }
  throw FormatException('not a colour: $v');
}

void main() {
  for (final theme in NbTheme.values) {
    test('${theme.name} matches theme.css', () {
      final css = themeTokens(theme.id);
      final c = theme.colors;
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
  }

  test('the themes are the web\'s, with the same kinds', () {
    final lang = File('../../shared/src/lang.ts').readAsStringSync();
    final kinds = {
      for (final m in RegExp(r"'?([a-z-]+)'?: '(dark|light)'").allMatches(
        lang.substring(
          lang.indexOf('THEME_KIND'),
          lang.indexOf('};', lang.indexOf('THEME_KIND')),
        ),
      ))
        m[1]!: m[2] == 'dark',
    };
    expect({for (final t in NbTheme.values) t.id: t.dark}, kinds);
    expect(NbTheme.byId('github-light'), NbTheme.githubLight);
    expect(NbTheme.byId('nope'), NbTheme.darcula);
    expect(NbTheme.byId(null), NbTheme.darcula);
  });

  test('a theme carries its tokens and brightness', () {
    for (final theme in NbTheme.values) {
      final t = theme.data;
      expect(t.brightness, theme.dark ? Brightness.dark : Brightness.light);
      expect(t.extension<NbColors>(), theme.colors);
      expect(t.scaffoldBackgroundColor, theme.colors.background);
    }
  });
}
