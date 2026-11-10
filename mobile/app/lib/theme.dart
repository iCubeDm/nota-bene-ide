// The six themes of web/src/theme.css (theme_test.dart checks every token against the file), as a ThemeExtension.
// Plannotator's OKLCH colours are converted to sRGB and clipped per channel, as the browsers paint them.
import 'package:flutter/material.dart';

@immutable
class NbColors extends ThemeExtension<NbColors> {
  const NbColors({
    required this.background,
    required this.foreground,
    required this.card,
    required this.popover,
    required this.muted,
    required this.mutedFg,
    required this.border,
    required this.borderSoft,
    required this.primary,
    required this.primaryFg,
    required this.accent,
    required this.destructive,
    required this.success,
    required this.link,
    required this.codeBg,
    required this.synText,
    required this.synKeyword,
    required this.synString,
    required this.synFunction,
    required this.synNumber,
    required this.synComment,
    required this.synType,
    required this.synVariable,
    required this.synProperty,
    required this.synTag,
    required this.synAdd,
    required this.synAddBg,
    required this.synDel,
    required this.synDelBg,
  });

  final Color background, foreground, card, popover, muted, mutedFg;
  final Color border, borderSoft, primary, primaryFg;

  /// `--nb-accent`: the brand accent, also the colour of warnings and pending items.
  final Color accent;
  final Color destructive, success, link, codeBg;
  final Color synText, synKeyword, synString, synFunction, synNumber;
  final Color synComment, synType, synVariable, synProperty, synTag;
  final Color synAdd, synAddBg, synDel, synDelBg;

  static const darcula = NbColors(
    background: Color(0xff2b2b2b),
    foreground: Color(0xffc9ced6),
    card: Color(0xff313131),
    popover: Color(0xff3c3f41),
    muted: Color(0xff434547),
    mutedFg: Color(0xffadb3ba),
    border: Color(0xff4c4f52),
    borderSoft: Color(0x12ffffff),
    primary: Color(0xff4876c0),
    primaryFg: Color(0xffffffff),
    accent: Color(0xffffc66d),
    destructive: Color(0xffff8980),
    success: Color(0xff66bf31),
    link: Color(0xff66acff),
    codeBg: Color(0xff2b2b2b),
    synText: Color(0xffa9b7c6),
    synKeyword: Color(0xffd17d38),
    synString: Color(0xff66bf31),
    synFunction: Color(0xffffc66d),
    synNumber: Color(0xff6897bb),
    synComment: Color(0xff929292),
    synType: Color(0xffffc66d),
    synVariable: Color(0xfff99e71),
    synProperty: Color(0xffa785ba),
    synTag: Color(0xffe8bf6a),
    synAdd: Color(0xffb5e3a0),
    synAddBg: Color(0xff294436),
    synDel: Color(0xffffb4ae),
    synDelBg: Color(0xff5c2e2e),
  );

  static const plannotator = NbColors(
    background: Color(0xff070b14),
    foreground: Color(0xffdadee5),
    card: Color(0xff151b24),
    popover: Color(0xff222935),
    muted: Color(0xff1e242e),
    mutedFg: Color(0xff9da5b1),
    border: Color(0xff343b45),
    borderSoft: Color(0x80343b45),
    primary: Color(0xff9a9dff),
    primaryFg: Color(0xff070b14),
    accent: Color(0xfff47700),
    destructive: Color(0xfff14d4c),
    success: Color(0xff3fc168),
    link: Color(0xff9a9dff),
    codeBg: Color(0xff1e242e),
    synText: Color(0xffc9d1d9),
    synKeyword: Color(0xffff7b72),
    synString: Color(0xffa5d6ff),
    synFunction: Color(0xffd2a8ff),
    synNumber: Color(0xff79c0ff),
    synComment: Color(0xff8b949e),
    synType: Color(0xffff7b72),
    synVariable: Color(0xff79c0ff),
    synProperty: Color(0xff79c0ff),
    synTag: Color(0xff7ee787),
    synAdd: Color(0xffaff5b4),
    synAddBg: Color(0xff033a16),
    synDel: Color(0xffffdcd7),
    synDelBg: Color(0xff67060c),
  );

  static const intellijLight = NbColors(
    background: Color(0xffffffff),
    foreground: Color(0xff080808),
    card: Color(0xffffffff),
    popover: Color(0xffffffff),
    muted: Color(0xffe6e7eb),
    mutedFg: Color(0xff636775),
    border: Color(0xffc9ccd6),
    borderSoft: Color(0x14000000),
    primary: Color(0xff3170ec),
    primaryFg: Color(0xffffffff),
    accent: Color(0xff8b6705),
    destructive: Color(0xffc7222d),
    success: Color(0xff067d17),
    link: Color(0xff2470b3),
    codeBg: Color(0xfff7f8fa),
    synText: Color(0xff080808),
    synKeyword: Color(0xff0033b3),
    synString: Color(0xff067d17),
    synFunction: Color(0xff00627a),
    synNumber: Color(0xff1750eb),
    synComment: Color(0xff727272),
    synType: Color(0xff000000),
    synVariable: Color(0xff080808),
    synProperty: Color(0xff871094),
    synTag: Color(0xff0033b3),
    synAdd: Color(0xff0b5d1a),
    synAddBg: Color(0xffdff3e1),
    synDel: Color(0xffa3141f),
    synDelBg: Color(0xfffbe1e1),
  );

  static const githubLight = NbColors(
    background: Color(0xffffffff),
    foreground: Color(0xff1f2328),
    card: Color(0xffffffff),
    popover: Color(0xffffffff),
    muted: Color(0xffeaedf0),
    mutedFg: Color(0xff59636e),
    border: Color(0xffccd3da),
    borderSoft: Color(0x141f2328),
    primary: Color(0xff1f883d),
    primaryFg: Color(0xffffffff),
    accent: Color(0xff8d6c06),
    destructive: Color(0xffd1242f),
    success: Color(0xff1a7f37),
    link: Color(0xff0969da),
    codeBg: Color(0xfff6f8fa),
    synText: Color(0xff1f2328),
    synKeyword: Color(0xffcf222e),
    synString: Color(0xff0a3069),
    synFunction: Color(0xff6639ba),
    synNumber: Color(0xff0550ae),
    synComment: Color(0xff59636e),
    synType: Color(0xff953800),
    synVariable: Color(0xff953800),
    synProperty: Color(0xff0550ae),
    synTag: Color(0xff116329),
    synAdd: Color(0xff116329),
    synAddBg: Color(0xffdafbe1),
    synDel: Color(0xff82071e),
    synDelBg: Color(0xffffebe9),
  );

  static const solarizedLight = NbColors(
    background: Color(0xfffdf6e3),
    foreground: Color(0xff364a51),
    card: Color(0xfffdf6e3),
    popover: Color(0xfffdf6e3),
    muted: Color(0xffe3ddcb),
    mutedFg: Color(0xff4f646c),
    border: Color(0xff93a1a1),
    borderSoft: Color(0x1a073642),
    primary: Color(0xff006cb1),
    primaryFg: Color(0xffffffff),
    accent: Color(0xff836205),
    destructive: Color(0xffcd1e21),
    success: Color(0xff5f7000),
    link: Color(0xff006cb1),
    codeBg: Color(0xfffdf6e3),
    synText: Color(0xff566c73),
    synKeyword: Color(0xff5f7000),
    synString: Color(0xff00756e),
    synFunction: Color(0xff006cb1),
    synNumber: Color(0xffc22374),
    synComment: Color(0xff667474),
    synType: Color(0xff8b6100),
    synVariable: Color(0xff006cb1),
    synProperty: Color(0xff5d60b2),
    synTag: Color(0xff006cb1),
    synAdd: Color(0xff5f7000),
    synAddBg: Color(0xffe9efd0),
    synDel: Color(0xffcd1e21),
    synDelBg: Color(0xfffaece4),
  );

  static const solarizedDark = NbColors(
    background: Color(0xff002b36),
    foreground: Color(0xffbac9c9),
    card: Color(0xff002b36),
    popover: Color(0xff073642),
    muted: Color(0xff11424f),
    mutedFg: Color(0xff9bacae),
    border: Color(0xff2f5a66),
    borderSoft: Color(0x12ffffff),
    primary: Color(0xff006cb1),
    primaryFg: Color(0xffffffff),
    accent: Color(0xffc69925),
    destructive: Color(0xffff7569),
    success: Color(0xff94a924),
    link: Color(0xff47a6ef),
    codeBg: Color(0xff00232c),
    synText: Color(0xff91a3a5),
    synKeyword: Color(0xff94a924),
    synString: Color(0xff3eb0a7),
    synFunction: Color(0xff47a6ef),
    synNumber: Color(0xffff6cab),
    synComment: Color(0xff7f969d),
    synType: Color(0xffc69925),
    synVariable: Color(0xff47a6ef),
    synProperty: Color(0xff9299f0),
    synTag: Color(0xff47a6ef),
    synAdd: Color(0xffb8cc5a),
    synAddBg: Color(0xff12382a),
    synDel: Color(0xffff9d94),
    synDelBg: Color(0xff3d1f24),
  );

  @override
  NbColors copyWith() => this;

  /// The user's bubble: the primary colour over the background.
  Color get userBubble =>
      Color.alphaBlend(primary.withValues(alpha: .28), background);

  /// The agent's bubble: the text colour faintly over the background, so that it lifts off the page in every theme and
  /// stays apart from the user's bubble and from a code block ([codeBg]).
  Color get agentBubble =>
      Color.alphaBlend(foreground.withValues(alpha: .14), background);

  @override
  NbColors lerp(ThemeExtension<NbColors>? other, double t) => this;
}

/// The web's themes (shared THEMES, THEME_KIND), with the same ids. The phone keeps its own choice (Settings).
enum NbTheme {
  // dark first, then light: the order of the pickers (Settings groups them under their headings)
  darcula('darcula', 'Darcula', true, NbColors.darcula),
  plannotator('plannotator', 'Plannotator', true, NbColors.plannotator),
  solarizedDark(
    'solarized-dark',
    'Solarized Dark',
    true,
    NbColors.solarizedDark,
  ),
  intellijLight(
    'intellij-light',
    'IntelliJ Light',
    false,
    NbColors.intellijLight,
  ),
  githubLight('github-light', 'GitHub Light', false, NbColors.githubLight),
  solarizedLight(
    'solarized-light',
    'Solarized Light',
    false,
    NbColors.solarizedLight,
  );

  const NbTheme(this.id, this.label, this.dark, this.colors);

  final String id;

  /// Not translated: a theme's name is a proper name, as on the web.
  final String label;
  final bool dark;
  final NbColors colors;

  static NbTheme byId(String? id) =>
      values.firstWhere((t) => t.id == id, orElse: () => darcula);

  ThemeData get data {
    final c = colors;
    final scheme = (dark ? const ColorScheme.dark() : const ColorScheme.light())
        .copyWith(
          surface: c.background,
          onSurface: c.foreground,
          surfaceContainer: c.card,
          surfaceContainerHigh: c.popover,
          surfaceContainerHighest: c.muted,
          onSurfaceVariant: c.mutedFg,
          primary: c.primary,
          onPrimary: c.primaryFg,
          secondary: c.accent,
          error: c.destructive,
          outline: c.border,
          outlineVariant: c.borderSoft,
        );
    return ThemeData(
      colorScheme: scheme,
      brightness: dark ? Brightness.dark : Brightness.light,
      scaffoldBackgroundColor: c.background,
      dividerColor: c.border,
      appBarTheme: AppBarTheme(
        backgroundColor: c.popover,
        foregroundColor: c.foreground,
      ),
      bottomSheetTheme: BottomSheetThemeData(backgroundColor: c.popover),
      extensions: [c],
    );
  }
}
