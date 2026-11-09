// The comment sheet, as the spec sketches it: the quoted selection, the quick labels in a row, a multi-line field.
import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/window_tab.dart';
import '../dictation/record_bar.dart';
import '../dictation/voice_button.dart';
import '../dictation/voice_chooser.dart';
import '../dictation/whisper_sheet.dart';
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

/// Null when dismissed. With [editing], the fields start from it and Delete is offered. With the [tab], a voice
/// control records for the window's Whisper, as the composer's does; without, there is none.
Future<SheetResult?> showCommentSheet(
  BuildContext context, {
  required String quote,
  Comment? editing,
  WindowTab? tab,
}) => showModalBottomSheet<SheetResult>(
  context: context,
  isScrollControlled: true,
  showDragHandle: true,
  builder: (_) => _Sheet(quote: quote, editing: editing, tab: tab),
);

class _Sheet extends StatefulWidget {
  const _Sheet({required this.quote, this.editing, this.tab});
  final String quote;
  final Comment? editing;
  final WindowTab? tab;

  @override
  State<_Sheet> createState() => _SheetState();
}

class _SheetState extends State<_Sheet> {
  late final _text = TextEditingController(text: widget.editing?.text ?? '');
  late QuickLabelId? _label = widget.editing?.label;
  final _meter = VoiceMeter();
  VoiceState _voice = VoiceState.idle;

  @override
  void dispose() {
    _text.dispose();
    _meter.dispose();
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
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Stack(
                  children: [
                    // kept while recording: the words still land in it
                    Visibility(
                      visible: _voice == VoiceState.idle,
                      maintainState: true,
                      maintainSize: true,
                      maintainAnimation: true,
                      child: TextField(
                        controller: _text,
                        autofocus: widget.editing == null,
                        minLines: 2,
                        maxLines: 8,
                        textCapitalization: TextCapitalization.sentences,
                        decoration: InputDecoration(
                          hintText: t.commentHint,
                          border: const OutlineInputBorder(),
                        ),
                      ),
                    ),
                    if (_voice != VoiceState.idle)
                      Positioned.fill(
                        child: Align(
                          alignment: Alignment.topCenter,
                          child: SizedBox(
                            height: 56,
                            child: RecordBar(state: _voice, meter: _meter),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              if (widget.tab case final tab?)
                // a context under the sheet's own messenger, so "Whisper is on" shows above the sheet
                Builder(
                  builder: (inner) => VoiceButton(
                    controller: _text,
                    meter: _meter,
                    onState: (v) => setState(() => _voice = v),
                    chooser: voiceChooser(tab),
                    onUnavailable: () => showWhisperSheet(inner, tab),
                  ),
                ),
            ],
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
                onPressed: () async {
                  // a running dictation is finished first: its words are in the field before it is read
                  await VoiceButton.finishRunning();
                  if (!context.mounted) return;
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
