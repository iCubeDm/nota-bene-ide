// The Darcula tokens of web/src/theme.css (theme_test.dart checks them against the file), as a ThemeExtension.
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

  @override
  NbColors copyWith() => this;

  @override
  NbColors lerp(ThemeExtension<NbColors>? other, double t) => this;
}

ThemeData darcula() {
  const c = NbColors.darcula;
  final scheme = const ColorScheme.dark().copyWith(
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
    brightness: Brightness.dark,
    scaffoldBackgroundColor: c.background,
    dividerColor: c.border,
    appBarTheme: AppBarTheme(
      backgroundColor: c.popover,
      foregroundColor: c.foreground,
    ),
    bottomSheetTheme: BottomSheetThemeData(backgroundColor: c.popover),
    extensions: const [c],
  );
}
