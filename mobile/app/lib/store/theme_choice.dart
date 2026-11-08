// The phone's colour theme (Settings), kept in the vault: one choice for every host, Darcula until one is picked.
import 'package:flutter/foundation.dart';

import '../theme.dart';
import 'vault.dart';

class ThemeChoice extends ChangeNotifier {
  ThemeChoice._(this._vault, this._theme);

  static const _key = 'theme';

  static Future<ThemeChoice> load(Vault v) async =>
      ThemeChoice._(v, NbTheme.byId(await v.read(_key)));

  final Vault _vault;
  NbTheme _theme;

  NbTheme get theme => _theme;

  Future<void> choose(NbTheme t) async {
    if (t == _theme) return;
    _theme = t;
    notifyListeners();
    await _vault.write(_key, t.id);
  }
}
