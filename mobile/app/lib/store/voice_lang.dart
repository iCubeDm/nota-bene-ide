// The language Whisper is asked for (Settings), kept in the vault: voice messages and comment dictation use it, and
// none follows the app's own language. A later recording only: a pending voice keeps the language it was made with.
import 'package:flutter/widgets.dart';

import 'vault.dart';

/// The languages Whisper is asked for, by their own names (the app's six).
const voiceLangs = <(String, String)>[
  ('en', 'English'),
  ('ru', 'Русский'),
  ('zh', '中文'),
  ('es', 'Español'),
  ('pt', 'Português'),
  ('de', 'Deutsch'),
];

class VoiceLang extends ChangeNotifier {
  VoiceLang._(this._vault, this._code);

  static const _key = 'voiceLang';

  static Future<VoiceLang> load(Vault v) async {
    final code = await v.read(_key);
    return VoiceLang._(v, voiceLangs.any((l) => l.$1 == code) ? code : null);
  }

  final Vault _vault;
  String? _code;

  /// The picked language's code; null follows the app's language.
  String? get code => _code;

  Future<void> choose(String? code) async {
    if (code == _code) return;
    _code = code;
    notifyListeners();
    code == null ? await _vault.delete(_key) : await _vault.write(_key, code);
  }
}

/// Hands the choice to every route below the app.
class VoiceLangScope extends InheritedWidget {
  const VoiceLangScope({super.key, required this.choice, required super.child});
  final VoiceLang? choice;

  @override
  bool updateShouldNotify(VoiceLangScope old) => choice != old.choice;
}

/// The language a recording made now is transcribed in: the Settings choice, else the app's language. Read when the
/// recording is made, so it is not a dependency of the widget.
String voiceLangOf(BuildContext context) =>
    context.getInheritedWidgetOfExactType<VoiceLangScope>()?.choice?.code ??
    Localizations.localeOf(context).languageCode;
