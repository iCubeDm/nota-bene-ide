// The app opens only after the phone's own check: biometrics or the screen lock's PIN, pattern or password
// (BiometricPrompt with device credential). It locks again after five minutes in the background.
import 'package:flutter/material.dart';
import 'package:local_auth/local_auth.dart';
import 'package:local_auth_android/local_auth_android.dart';

import '../l10n/app_localizations.dart';

enum AuthResult { ok, failed, unavailable }

/// What the system's own dialog shows, in the app's language.
typedef AuthTexts = ({String title, String reason, String cancel});

abstract class Authenticator {
  Future<AuthResult> authenticate(AuthTexts texts);
}

class DeviceAuthenticator implements Authenticator {
  final _auth = LocalAuthentication();

  @override
  Future<AuthResult> authenticate(AuthTexts texts) async {
    try {
      if (!await _auth.isDeviceSupported()) return AuthResult.unavailable;
      final ok = await _auth.authenticate(
        localizedReason: texts.reason,
        authMessages: [
          AndroidAuthMessages(
            signInTitle: texts.title,
            signInHint: texts.reason,
            cancelButton: texts.cancel,
          ),
        ],
        persistAcrossBackgrounding: true,
      );
      return ok ? AuthResult.ok : AuthResult.failed;
    } on LocalAuthException catch (e) {
      return e.code == LocalAuthExceptionCode.noCredentialsSet
          ? AuthResult.unavailable
          : AuthResult.failed;
    }
  }
}

class LockGate extends StatefulWidget {
  const LockGate({
    super.key,
    required this.authenticator,
    required this.child,
    this.clock = DateTime.now,
    this.relockAfter = const Duration(minutes: 5),
  });

  final Authenticator authenticator;
  final Widget child;
  final DateTime Function() clock;
  final Duration relockAfter;

  @override
  State<LockGate> createState() => _LockGateState();
}

class _LockGateState extends State<LockGate> {
  late final AppLifecycleListener _life;
  bool _open = false;
  bool _asking = false;
  AuthResult? _last;
  DateTime? _hiddenAt;

  @override
  void initState() {
    super.initState();
    _life = AppLifecycleListener(
      onHide: () => _hiddenAt ??= widget.clock(),
      onShow: _back,
    );
    WidgetsBinding.instance.addPostFrameCallback((_) => _ask());
  }

  @override
  void dispose() {
    _life.dispose();
    super.dispose();
  }

  void _back() {
    final at = _hiddenAt;
    _hiddenAt = null;
    if (at != null && widget.clock().difference(at) >= widget.relockAfter) {
      setState(() => _open = false);
      _ask();
    }
  }

  Future<void> _ask() async {
    if (_asking || !mounted) return;
    _asking = true;
    final t = AppLocalizations.of(context);
    final r = await widget.authenticator.authenticate((
      title: t.lockTitle,
      reason: t.lockReason,
      cancel: t.cancel,
    ));
    _asking = false;
    if (!mounted) return;
    setState(() {
      _last = r;
      _open = r == AuthResult.ok;
    });
  }

  /// The app stays mounted under the lock (its connections and its place in the navigation survive a relock); while
  /// locked it is offstage, so nothing of it is painted, hit or read out.
  @override
  Widget build(BuildContext context) => Stack(
    fit: StackFit.expand,
    children: [
      Offstage(
        offstage: !_open,
        child: TickerMode(enabled: _open, child: widget.child),
      ),
      if (!_open) _lockScreen(context),
    ],
  );

  Widget _lockScreen(BuildContext context) {
    final t = AppLocalizations.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.lock_outline, size: 48),
                const SizedBox(height: 16),
                Text(
                  t.lockTitle,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 12),
                if (_last == AuthResult.unavailable)
                  Text(t.noScreenLock, textAlign: TextAlign.center)
                else ...[
                  if (_last == AuthResult.failed) Text(t.lockFailed),
                  const SizedBox(height: 16),
                  FilledButton(onPressed: _ask, child: Text(t.unlock)),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
