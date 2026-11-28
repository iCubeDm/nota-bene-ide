// ⇤ and ⇥ for the message field (issue 738): what Shift+Tab and Tab do on the web, for a phone keyboard has no Tab.
// The page places them where they cover nothing: the chat floats them above its bottom band, the comment sheet puts
// them in its row under the field.
import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import 'markdown_text.dart';

/// [text]'s ⇤ or ⇥ ([dir] -1 or 1) would change it.
bool _acts(MarkdownText text, int dir) =>
    !identical(nested(text.value, dir), text.value);

class NestButtons extends StatelessWidget {
  const NestButtons({super.key, required this.text, required this.focus});
  final MarkdownText text;
  final FocusNode focus;

  /// They show: the field is focused, its caret on a list item or in a code block, and one of them can act.
  static bool shown(MarkdownText text, FocusNode focus) =>
      focus.hasFocus && text.canNest && (_acts(text, -1) || _acts(text, 1));

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([text, focus]),
    builder: (context, _) {
      if (!shown(text, focus)) return const SizedBox.shrink();
      final t = AppLocalizations.of(context);
      final c = Theme.of(context).extension<NbColors>()!;
      Widget button(int dir, String key, String label, NbGlyph glyph) {
        final tap = _acts(text, dir) ? () => text.nest(dir) : null;
        // named and tappable for TalkBack (the button's own tooltip is not a label)
        return Semantics(
          label: label,
          button: true,
          enabled: tap != null,
          onTap: tap,
          excludeSemantics: true,
          child: IconButton(
            key: ValueKey(key),
            tooltip: label,
            icon: NbIcon(glyph),
            style: IconButton.styleFrom(
              fixedSize: const Size.square(44),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              backgroundColor: c.muted,
              foregroundColor: c.foreground,
              disabledBackgroundColor: c.muted,
              disabledForegroundColor: c.mutedFg,
            ),
            onPressed: tap,
          ),
        );
      }

      // a tap here is not a tap outside the field: a mouse or a stylus would take its focus
      return TextFieldTapRegion(
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            button(-1, 'nest-out', t.outdent, NbGlyph.outdent),
            const SizedBox(width: 8),
            button(1, 'nest-in', t.indent, NbGlyph.indent),
          ],
        ),
      );
    },
  );
}
