import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../l10n/app_localizations.dart';
import 'confirm_screen.dart';
import 'pair_flow.dart';

/// Scan the host's QR (or paste the `nbremote://` text), pair, then show the fingerprints.
class PairScreen extends StatefulWidget {
  const PairScreen({super.key, required this.flow, this.scanner = true});

  final PairFlow flow;

  /// false in tests: no camera
  final bool scanner;

  @override
  State<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends State<PairScreen> {
  bool _busy = false;
  PairError? _error;
  Paired? _done;

  Future<void> _pair(String code) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final r = await widget.flow.pair(code, deviceName: await deviceName());
    if (!mounted) return;
    setState(() {
      _busy = false;
      switch (r) {
        case Paired():
          _done = r;
        case PairFailed(:final reason):
          _error = reason;
      }
    });
  }

  Future<void> _paste() async {
    final d = await Clipboard.getData(Clipboard.kTextPlain);
    if (d?.text != null) await _pair(d!.text!);
  }

  String _message(AppLocalizations t, PairError e) => switch (e) {
    PairError.notACode => t.errNotACode,
    PairError.codeUsed => t.errCodeUsed,
    PairError.unreachable => t.errUnreachable,
  };

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final done = _done;
    if (done != null) {
      return ConfirmScreen(
        result: done,
        onDone: () => Navigator.of(context).maybePop(),
      );
    }
    return Scaffold(
      appBar: AppBar(title: Text(t.pairTitle)),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: _busy
                  ? Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const CircularProgressIndicator(),
                          const SizedBox(height: 12),
                          Text(t.pairing),
                        ],
                      ),
                    )
                  : widget.scanner
                  ? MobileScanner(
                      onDetect: (c) {
                        for (final b in c.barcodes) {
                          final v = b.rawValue;
                          if (v != null && v.startsWith('nbremote://')) {
                            _pair(v);
                            return;
                          }
                        }
                      },
                      errorBuilder: (context, e) => Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Text(
                            e.errorCode ==
                                    MobileScannerErrorCode.permissionDenied
                                ? t.cameraDenied
                                : t.cameraFailed,
                            textAlign: TextAlign.center,
                          ),
                        ),
                      ),
                    )
                  : const SizedBox.shrink(),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  if (_error != null)
                    Text(
                      _message(t, _error!),
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  const SizedBox(height: 8),
                  Text(t.scanHint, textAlign: TextAlign.center),
                  TextButton(
                    onPressed: _busy ? null : _paste,
                    child: Text(t.pasteCode),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
