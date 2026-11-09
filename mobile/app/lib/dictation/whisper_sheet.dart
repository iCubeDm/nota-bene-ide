// What the mic opens while the window has no Whisper: the install (or the switch) of Settings → Dictation, from the
// phone, followed until Whisper is on. The texts are the web's own where it has them.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../chat/window_tab.dart';
import '../comments/strings.g.dart';
import '../files/image_screen.dart' show windowHttp;
import '../l10n/app_localizations.dart';
import '../theme.dart';

// how often an install in progress is asked about
const _poll = Duration(seconds: 2);

Future<void> showWhisperSheet(BuildContext context, WindowTab tab) {
  final c = Theme.of(context).extension<NbColors>()!;
  final messenger = ScaffoldMessenger.of(context);
  return showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    backgroundColor: c.popover,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (_) => WhisperSheet(tab: tab, messenger: messenger),
  );
}

enum _Step { asking, absent, failed, installing, off, noAnswer }

class WhisperSheet extends StatefulWidget {
  const WhisperSheet({super.key, required this.tab, required this.messenger});
  final WindowTab tab;

  /// Where "Whisper is on" is said once the sheet has closed.
  final ScaffoldMessengerState messenger;

  @override
  State<WhisperSheet> createState() => _WhisperSheetState();
}

class _WhisperSheetState extends State<WhisperSheet> {
  _Step _step = _Step.asking;
  // the sizes and the folder of the install, from GET /dictation
  int _dl = 0, _disk = 0;
  String _dir = '';
  Timer? _timer;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _ask();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<({int status, Map<Object?, Object?> body})?> _call(
    String method,
    String path, [
    Object? json,
  ]) async {
    final http = windowHttp(widget.tab);
    if (http == null) return null;
    try {
      final r = await http(
        method,
        path,
        headers: json == null ? null : {'content-type': 'application/json'},
        body: json == null ? null : utf8.encode(jsonEncode(json)),
      );
      final v = r.body.isEmpty ? null : jsonDecode(utf8.decode(r.body));
      return (status: r.status, body: v is Map ? v : const {});
    } catch (_) {
      return null;
    }
  }

  void _show(_Step s) {
    if (!mounted) return;
    setState(() {
      _step = s;
      _busy = false;
    });
  }

  Future<void> _ask() async {
    final r = await _call('GET', '/dictation');
    if (!mounted) return;
    if (r == null || r.status != 200) return _show(_Step.noAnswer);
    final b = r.body;
    _dl = (b['downloadMb'] as num?)?.round() ?? 0;
    _disk = (b['diskMb'] as num?)?.round() ?? 0;
    _dir = b['dir'] is String ? b['dir'] as String : '';
    if (b['on'] == true) return _ready();
    switch (b['phase']) {
      case 'ready':
        // installed by this sheet: it goes on by itself, as Settings does
        if (_step == _Step.installing) return _turnOn();
        _show(_Step.off);
      case 'installing':
        _show(_Step.installing);
        _timer = Timer(_poll, _ask);
      case 'failed':
        _show(_Step.failed);
      default:
        _show(_Step.absent);
    }
  }

  Future<void> _install() async {
    setState(() => _busy = true);
    final r = await _call('POST', '/dictation/install');
    if (!mounted) return;
    // 409: an install is already running, which is as good
    if (r == null || (r.status != 202 && r.status != 409)) {
      return _show(_Step.noAnswer);
    }
    _show(_Step.installing);
    _timer = Timer(_poll, _ask);
  }

  Future<void> _turnOn() async {
    setState(() => _busy = true);
    final r = await _call('POST', '/dictation/on', {'on': true});
    if (!mounted) return;
    if (r == null || r.status != 200) return _show(_Step.noAnswer);
    _ready();
  }

  void _ready() {
    widget.tab.whisperOn = true;
    final text = AppLocalizations.of(context).whisperReady;
    Navigator.of(context).pop();
    widget.messenger.showSnackBar(SnackBar(content: Text(text)));
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final lang = Localizations.localeOf(context).languageCode;
    final (
      String? text,
      String? action,
      VoidCallback? onAction,
    ) = switch (_step) {
      _Step.asking => (null, null, null),
      _Step.absent => (
        batchTemplate('dictInstallQ', lang, [_dl, _disk, _dir]),
        webString('dictInstallGo', lang),
        _install,
      ),
      _Step.failed => (
        webString('dictFailed', lang),
        webString('dictRetry', lang),
        _install,
      ),
      _Step.installing => (webString('dictInstalling', lang), null, null),
      _Step.off => (t.whisperOff, t.whisperTurnOn, _turnOn),
      _Step.noAnswer => (t.whisperNoAnswer, null, null),
    };
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 36,
              height: 4,
              decoration: BoxDecoration(
                color: c.border,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const SizedBox(height: 16),
          Text(t.whisperTitle, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 10),
          if (text == null || _step == _Step.installing)
            const Center(
              child: Padding(
                padding: EdgeInsets.all(8),
                child: SizedBox.square(
                  dimension: 22,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            ),
          if (text != null) Text(text, style: TextStyle(color: c.mutedFg)),
          if (action != null) ...[
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _busy ? null : onAction,
              child: Text(action),
            ),
          ],
        ],
      ),
    );
  }
}
