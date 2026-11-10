// The app's language (Settings), kept in the vault like the theme: the phone's own until one of Nota Bene's is picked.
import 'package:flutter/widgets.dart';

import 'vault.dart';

/// Nota Bene's languages by their own names, in the web's order (zh is zh-CN, pt is pt-BR).
const appLangs = <(String, String)>[
  ('en', 'English'),
  ('ru', 'Русский'),
  ('zh', '简体中文'),
  ('es', 'Español'),
  ('pt', 'Português (Brasil)'),
  ('de', 'Deutsch'),
];

class LangChoice extends ChangeNotifier {
  LangChoice._(this._vault, this._code);

  static const _key = 'lang';

  static Future<LangChoice> load(Vault v) async {
    final code = await v.read(_key);
    return LangChoice._(v, appLangs.any((l) => l.$1 == code) ? code : null);
  }

  final Vault _vault;
  String? _code;

  /// The picked language's code; null follows the phone.
  String? get code => _code;

  /// What the app is shown in: null lets the phone's languages decide.
  Locale? get locale => _code == null ? null : Locale(_code!);

  Future<void> choose(String? code) async {
    if (code == _code) return;
    _code = code;
    notifyListeners();
    code == null ? await _vault.delete(_key) : await _vault.write(_key, code);
  }
}
