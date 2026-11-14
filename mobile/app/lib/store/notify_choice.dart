// Whether the phone notifies about agents and keeps its links while they work (Settings → Notifications), kept in the
// vault like the theme; on until turned off.
import 'package:flutter/widgets.dart';

import 'vault.dart';

class NotifyChoice extends ChangeNotifier {
  NotifyChoice._(this._vault, this._on);

  static const _key = 'nb.notify';

  static Future<NotifyChoice> load(Vault v) async =>
      NotifyChoice._(v, await v.read(_key) != 'off');

  final Vault _vault;
  bool _on;
  bool get on => _on;

  Future<void> set(bool on) async {
    if (on == _on) return;
    _on = on;
    notifyListeners();
    on ? await _vault.delete(_key) : await _vault.write(_key, 'off');
  }
}
