// The mic in a text field: dictation lands at the cursor, partial results replacing each other until the final one.
import 'dart:async';
import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../theme.dart';
import 'dictation.dart';

class MicButton extends StatefulWidget {
  const MicButton({super.key, required this.controller, this.enabled = true});
  final TextEditingController controller;
  final bool enabled;

  /// Ends the dictation in progress, if any, before its field is read.
  static void cancelRunning() => _MicButtonState._current?._end(cancel: true);

  @override
  State<MicButton> createState() => _MicButtonState();
}

class _MicButtonState extends State<MicButton> {
  // only one mic listens at a time: starting another cancels this one
  static _MicButtonState? _current;

  StreamSubscription<DictationEvent>? _sub;
  String _before = '';
  String _after = '';
  bool get _listening => _sub != null;

  @override
  void didUpdateWidget(MicButton old) {
    super.didUpdateWidget(old);
    if (!widget.enabled && _listening) _end(cancel: true);
  }

  @override
  void dispose() {
    if (_listening) _end(cancel: true, rebuild: false);
    super.dispose();
  }

  void _end({required bool cancel, bool rebuild = true}) {
    _sub?.cancel();
    _sub = null;
    if (identical(_current, this)) _current = null;
    if (cancel) dictation.cancel();
    if (rebuild && mounted) setState(() {});
  }

  void _start() {
    _current?._end(cancel: true);
    final text = widget.controller.text;
    final sel = widget.controller.selection;
    final at = sel.isValid ? sel : TextSelection.collapsed(offset: text.length);
    _before = at.textBefore(text);
    _after = at.textAfter(text);
    final ui = Localizations.localeOf(context).languageCode;
    final tag = speechTag(
      ui,
      WidgetsBinding.instance.platformDispatcher.locale,
    );
    _current = this;
    _sub = dictation.listen(tag).listen(_on);
    setState(() {});
  }

  void _put(String words) {
    final sep = _before.isNotEmpty && !RegExp(r'\s$').hasMatch(_before)
        ? ' '
        : '';
    final head = '$_before$sep$words';
    widget.controller.value = TextEditingValue(
      text: '$head$_after',
      selection: TextSelection.collapsed(offset: head.length),
    );
  }

  void _on(DictationEvent e) {
    switch (e) {
      case DictationPartial(:final text) || DictationFinal(:final text):
        _put(text);
      case DictationError(:final why):
        // the field goes back to what it was before the dictation
        widget.controller.value = TextEditingValue(
          text: '$_before$_after',
          selection: TextSelection.collapsed(offset: _before.length),
        );
        final t = AppLocalizations.of(context);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(switch (why) {
              DictationFailure.denied => t.dictationDenied,
              DictationFailure.unavailable => t.dictationUnavailable,
              DictationFailure.noMatch => t.dictationNoMatch,
              DictationFailure.failed => t.dictationFailed,
            }),
          ),
        );
      case DictationEnd():
        _end(cancel: false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    return IconButton(
      tooltip: _listening ? t.dictateStop : t.dictate,
      icon: Icon(
        _listening ? Icons.mic : Icons.mic_none,
        color: _listening ? c.accent : null,
      ),
      onPressed: !widget.enabled
          ? null
          : _listening
          ? () => dictation.stop()
          : _start,
    );
  }
}
