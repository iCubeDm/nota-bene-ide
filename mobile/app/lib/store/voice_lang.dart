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

/// The first protocol where the host detects the spoken language (`detect`) and names it (`lang`).
const detectProtocol = 18;

/// The endonym of [code] for a badge or a screen reader: the app's six by their own names, the code otherwise.
String voiceLangName(String code) =>
    voiceLangs.where((l) => l.$1 == code).firstOrNull?.$2 ?? code;

class VoiceLang extends ChangeNotifier {
  VoiceLang._(this._vault, this._code);

  static const _key = 'voiceLang';

  /// The default: the host detects the language, the app's language being the hint. Nothing is stored for it, so the
  /// old default (nothing stored, "app language") is Automatic now.
  static const auto = 'auto';

  static Future<VoiceLang> load(Vault v) async {
    final code = await v.read(_key);
    return VoiceLang._(v, voiceLangs.any((l) => l.$1 == code) ? code! : auto);
  }

  final Vault _vault;
  String _code;

  /// [auto], or the pinned language's code.
  String get code => _code;
  bool get isAuto => _code == auto;

  Future<void> choose(String code) async {
    if (code == _code) return;
    _code = code;
    notifyListeners();
    code == auto ? await _vault.delete(_key) : await _vault.write(_key, code);
  }
}

/// Hands the choice to every route below the app.
class VoiceLangScope extends InheritedWidget {
  const VoiceLangScope({super.key, required this.choice, required super.child});
  final VoiceLang? choice;

  @override
  bool updateShouldNotify(VoiceLangScope old) => choice != old.choice;
}

/// The language a recording made now is transcribed in, or hinted with under Automatic: the pin, else the app's
/// language. Read when the recording is made, so it is not a dependency of the widget.
String voiceLangOf(BuildContext context) {
  final c = context.getInheritedWidgetOfExactType<VoiceLangScope>()?.choice;
  return c == null || c.isAuto
      ? Localizations.localeOf(context).languageCode
      : c.code;
}

/// Whether a recording made now asks the host to detect the language (Automatic, the default). The host's protocol is
/// checked where the request is made.
bool voiceDetectOf(BuildContext context) =>
    context.getInheritedWidgetOfExactType<VoiceLangScope>()?.choice?.isAuto ??
    true;

/// The hint in effect for a badge, only under Automatic: a pin is not a detection, so there is nothing to point out.
String? voiceHintOf(BuildContext context) => voiceDetectOf(context)
    ? Localizations.localeOf(context).languageCode
    : null;
