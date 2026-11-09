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
  late final AppLifecycleListener _lifecycle;
  // the field as it was at the start, and as this button last wrote it
  TextEditingValue _saved = TextEditingValue.empty;
  TextEditingValue? _written;
  String _before = '';
  String _after = '';
  bool _stopping = false;
  bool get _listening => _sub != null;

  @override
  void initState() {
    super.initState();
    // onHide, not onInactive: the permission dialog and a notification shade only make the app inactive,
    // while onHide means the app is really out of sight.
    _lifecycle = AppLifecycleListener(
      onHide: () {
        if (_listening) _end(cancel: true);
      },
    );
  }

  @override
  void didUpdateWidget(MicButton old) {
    super.didUpdateWidget(old);
    if (!widget.enabled && _listening) _end(cancel: true);
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    if (_listening) _end(cancel: true, rebuild: false);
    super.dispose();
  }

  // the platform call is not awaited; its failure must not become an unhandled error
  static void _fire(Future<void> call) => unawaited(call.catchError((_) {}));

  void _end({required bool cancel, bool rebuild = true}) {
    _sub?.cancel();
    _sub = null;
    _stopping = false;
    _written = null;
    if (identical(_current, this)) _current = null;
    if (cancel) _fire(dictation.cancel());
    if (rebuild && mounted) setState(() {});
  }

  void _start() {
    _current?._end(cancel: true);
    final value = widget.controller.value;
    final text = value.text;
    final sel = value.selection;
    final at = sel.isValid ? sel : TextSelection.collapsed(offset: text.length);
    _saved = value;
    _written = value;
    _before = at.textBefore(text);
    _after = at.textAfter(text);
    final ui = Localizations.localeOf(context).languageCode;
    final tag = speechTag(
      ui,
      WidgetsBinding.instance.platformDispatcher.locales,
    );
    _stopping = false;
    _current = this;
    _sub = dictation.listen(tag).listen(_on);
    setState(() {});
  }

  void _put(String words) {
    final sep = _before.isNotEmpty && !RegExp(r'\s$').hasMatch(_before)
        ? ' '
        : '';
    final gap = _after.isNotEmpty && !RegExp(r'^\s').hasMatch(_after)
        ? ' '
        : '';
    final head = '$_before$sep$words';
    final value = TextEditingValue(
      text: '$head$gap$_after',
      selection: TextSelection.collapsed(offset: head.length),
    );
    _written = widget.controller.value = value;
  }

  void _on(DictationEvent e) {
    if (e is! DictationEnd && widget.controller.value != _written) {
      // the user typed or moved the cursor: their field wins and the dictation is over
      _end(cancel: true);
      return;
    }
    switch (e) {
      case DictationPartial(:final text):
        _put(text);
      case DictationFinal(:final text):
        // an empty result must not erase the partials
        if (text.isNotEmpty) _put(text);
      case DictationError(:final why):
        // the field goes back to exactly what it was, selection included
        widget.controller.value = _saved;
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
          ? _stop
          : _start,
    );
  }

  // one stop per session: a second one could lose the result
  void _stop() {
    if (_stopping) return;
    _stopping = true;
    _fire(dictation.stop());
  }
}
