// The comment sheet, as the spec sketches it: the quoted selection, the quick labels in a row, a multi-line field.
import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../dictation/mic_button.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import 'strings.g.dart';

/// What the sheet gave: a comment to save, or the edited one deleted.
sealed class SheetResult {}

class SheetSave extends SheetResult {
  SheetSave(this.text, this.label);
  final String text;
  final QuickLabelId? label;
}

class SheetDelete extends SheetResult {}

/// Null when dismissed. With [editing], the fields start from it and Delete is offered.
Future<SheetResult?> showCommentSheet(
  BuildContext context, {
  required String quote,
  Comment? editing,
}) => showModalBottomSheet<SheetResult>(
  context: context,
  isScrollControlled: true,
  showDragHandle: true,
  builder: (_) => _Sheet(quote: quote, editing: editing),
);

class _Sheet extends StatefulWidget {
  const _Sheet({required this.quote, this.editing});
  final String quote;
  final Comment? editing;

  @override
  State<_Sheet> createState() => _SheetState();
}

class _SheetState extends State<_Sheet> {
  late final _text = TextEditingController(text: widget.editing?.text ?? '');
  late QuickLabelId? _label = widget.editing?.label;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final lang = Localizations.localeOf(context).languageCode;
    final sheet = Padding(
      padding: EdgeInsets.fromLTRB(
        16,
        0,
        16,
        16 + MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.only(left: 10),
            decoration: BoxDecoration(
              border: Border(left: BorderSide(color: c.accent, width: 3)),
            ),
            child: Text(
              widget.quote,
              maxLines: 4,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: c.mutedFg),
            ),
          ),
          const SizedBox(height: 12),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final l in quickLabels)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    // the name is the tooltip (a long press), as on the message menu's labels
                    child: Tooltip(
                      message: l.textIn(lang),
                      child: GestureDetector(
                        onTap: () => setState(
                          () => _label = _label == l.id ? null : l.id,
                        ),
                        child: Container(
                          key: ValueKey('label:${l.id.name}'),
                          width: 32,
                          height: 32,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: c.muted,
                            border: Border.all(
                              color: _label == l.id
                                  ? c.accent
                                  : Colors.transparent,
                              width: 2,
                            ),
                          ),
                          child: Text(
                            l.emoji,
                            style: const TextStyle(fontSize: 16, height: 1),
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _text,
            autofocus: widget.editing == null,
            minLines: 2,
            maxLines: 8,
            textCapitalization: TextCapitalization.sentences,
            decoration: InputDecoration(
              hintText: t.commentHint,
              border: const OutlineInputBorder(),
              suffixIcon: MicButton(controller: _text),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              if (widget.editing != null)
                TextButton(
                  onPressed: () => Navigator.pop(context, SheetDelete()),
                  child: Text(
                    t.deleteComment,
                    style: TextStyle(color: c.destructive),
                  ),
                ),
              const Spacer(),
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: Text(t.cancel),
              ),
              FilledButton(
                onPressed: () {
                  // a running dictation must not write after the field is read
                  MicButton.cancelRunning();
                  Navigator.pop(context, SheetSave(_text.text.trim(), _label));
                },
                child: Text(t.save),
              ),
            ],
          ),
        ],
      ),
    );
    // The sheet covers the page's Scaffold, so a SnackBar shown there would be hidden under it: the sheet has
    // its own messenger, and an invisible Scaffold of the sheet's size to show it on.
    return ScaffoldMessenger(
      child: Stack(
        children: [
          sheet,
          Positioned.fill(
            child: IgnorePointer(
              child: Scaffold(
                backgroundColor: Colors.transparent,
                resizeToAvoidBottomInset: false,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
