// A code block full screen: black on the code background, line numbers beside the code, pinch-zoom and panning both
// ways (lines are never wrapped), selectable text, copy and close in the bar.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../comments/anchor.dart';
import '../comments/chat_anchor.dart';
import '../comments/comment_sheet.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import 'code.dart';
import 'feed.dart';
import 'window_tab.dart';

/// Opens [code] full screen. With the [tab] and the [item] it belongs to, a selection in it can be commented.
void openCode(
  BuildContext context,
  String code,
  String? lang, {
  WindowTab? tab,
  FeedItem? item,
}) {
  Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => CodeScreen(code: code, lang: lang, tab: tab, item: item),
    ),
  );
}

class CodeScreen extends StatefulWidget {
  const CodeScreen({
    super.key,
    required this.code,
    this.lang,
    this.tab,
    this.item,
  });

  final String code;
  final String? lang;

  /// The window and the message the code is from: a selection becomes a comment on the message.
  final WindowTab? tab;
  final FeedItem? item;

  @override
  State<CodeScreen> createState() => _CodeScreenState();
}

class _CodeScreenState extends State<CodeScreen> {
  String _selected = '';

  String get _text => widget.code.endsWith('\n')
      ? widget.code.substring(0, widget.code.length - 1)
      : widget.code;

  /// The selection in the message's text: found inside this code block's own place there, so the same words in the
  /// prose around it are not taken for it.
  Future<void> _comment() async {
    final tab = widget.tab, item = widget.item;
    final source = item == null ? null : chatSource(item);
    final r = item == null ? null : chatText(item);
    if (tab == null || r == null || source == null) return;
    final block = locateSelection(r, _text, null);
    final at = locateSelection(r, _selected, block?.start, within: block);
    if (at == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(AppLocalizations.of(context).commentNotPlaced)),
      );
      return;
    }
    final res = await showCommentSheet(
      context,
      quote: r.text.substring(at.start, at.end),
    );
    if (res is! SheetSave) return;
    tab.comments.add(
      makeAnchor(source, r.text, at.start, at.end),
      res.text,
      res.label,
    );
  }

  @override
  Widget build(BuildContext context) {
    final code = widget.code, lang = widget.lang;
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
                if (lang != null && lang.isNotEmpty)
                  Text(
                    lang,
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
                if (widget.tab != null && widget.item != null)
                  IconButton(
                    tooltip: t.comment,
                    icon: NbIcon(NbGlyph.comments, color: c.foreground),
                    onPressed: _selected.trim().isEmpty ? null : _comment,
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
                onSelectionChanged: (s) =>
                    setState(() => _selected = s?.plainText ?? ''),
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
