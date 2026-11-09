// A code block full screen: black on the code background, line numbers beside the code, pinch-zoom and panning both
// ways (lines are never wrapped), selectable text, copy and close in the bar.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import 'code.dart';

void openCode(BuildContext context, String code, String? lang) {
  Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => CodeScreen(code: code, lang: lang),
    ),
  );
}

class CodeScreen extends StatelessWidget {
  const CodeScreen({super.key, required this.code, this.lang});

  final String code;
  final String? lang;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    final t = AppLocalizations.of(context);
    final text = code.endsWith('\n')
        ? code.substring(0, code.length - 1)
        : code;
    final count = text.split('\n').length;
    final style = TextStyle(
      fontFamily: 'monospace',
      fontSize: 13,
      color: c.synText,
      height: 1.5,
    );
    return Scaffold(
      backgroundColor: c.codeBg,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                IconButton(
                  tooltip: MaterialLocalizations.of(context).closeButtonTooltip,
                  icon: NbIcon(NbGlyph.close, color: c.foreground),
                  onPressed: () => Navigator.of(context).maybePop(),
                ),
                if (lang != null && lang!.isNotEmpty)
                  Text(
                    lang!,
                    style: TextStyle(color: c.foreground, fontSize: 14),
                  ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    t.codeLines(count),
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: c.mutedFg, fontSize: 12),
                  ),
                ),
                IconButton(
                  tooltip: t.copy,
                  icon: NbIcon(NbGlyph.copy, color: c.foreground),
                  onPressed: () => Clipboard.setData(ClipboardData(text: text)),
                ),
              ],
            ),
            Expanded(
              child: SelectionArea(
                child: InteractiveViewer(
                  constrained: false,
                  minScale: 0.5,
                  maxScale: 3,
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        SelectionContainer.disabled(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              for (var i = 1; i <= count; i++)
                                Text(
                                  '$i',
                                  style: style.copyWith(color: c.mutedFg),
                                ),
                            ],
                          ),
                        ),
                        const SizedBox(width: 12),
                        Text.rich(
                          TextSpan(
                            style: style,
                            children: highlightSpans(text, lang, c),
                          ),
                          softWrap: false,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
