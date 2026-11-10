// The phone's own key and the hosts it is paired with. The key is made once and never leaves the vault.
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:nb_channel/nb_channel.dart' hide fingerprint;
import 'package:nb_channel/nb_channel.dart' as nb show fingerprint;

import 'vault.dart';

class Identity {
  Identity._(this.key);
  final KeyPair key;

  static const _slot = 'nb.identity';

  static Future<Identity> load(Vault v) async {
    final s = await v.read(_slot);
    if (s == null) {
      final key = await generateKeyPair();
      await v.write(_slot, b64u(key.priv));
      return Identity._(key);
    }
    final Uint8List priv;
    try {
      priv = fromB64u(s, 32);
    } on FormatException {
      throw VaultCorrupt(_slot);
    }
    return Identity._((priv: priv, pub: await publicOf(priv)));
  }

  Future<String> get fingerprint => nb.fingerprint(key.pub);
}

class PairedHost {
  PairedHost({
    required this.id,
    required this.relay,
    required String label,
    required this.pairedAt,
    this.computerName,
    this.customName,
  }) : fallbackLabel = label;

  factory PairedHost.fromJson(Map<String, Object?> j) => PairedHost(
    id: j['id'] as String,
    relay: Uri.parse(j['relay'] as String),
    label: j['label'] as String,
    pairedAt: DateTime.parse(j['pairedAt'] as String),
    computerName: j['computerName'] as String?,
    customName: j['customName'] as String?,
  );

  /// The host's static public key, base64url (also the relay's host id).
  final String id;
  final Uri relay;

  /// What the list called this host before it sent a computer name: the folder of its first window, or the
  /// fingerprint prefix.
  final String fallbackLabel;
  final DateTime pairedAt;

  /// What the host's computer calls itself, as the host last sent it.
  String? computerName;

  /// The name chosen on this phone (kept here only); null: the computer's name shows.
  String? customName;

  /// What the list calls this host: the name chosen here, else the computer's, else the fallback.
  String get label => customName ?? computerName ?? fallbackLabel;

  Uint8List get pub => fromB64u(id, 32);

  Map<String, Object?> toJson() => {
    'id': id,
    'relay': '$relay',
    'label': fallbackLabel,
    'pairedAt': pairedAt.toUtc().toIso8601String(),
    'computerName': ?computerName,
    'customName': ?customName,
  };
}

class Hosts extends ChangeNotifier {
  Hosts._(this._v, this._all, this._lastChat);

  final Vault _v;
  final List<PairedHost> _all;
  String? _lastChat;

  static const _slot = 'nb.hosts';
  static const _lastSlot = 'nb.lastChat';

  static Future<Hosts> load(Vault v) async {
    final list = <PairedHost>[];
    final s = await v.read(_slot);
    if (s != null) {
      try {
        for (final e in jsonDecode(s) as List) {
          list.add(PairedHost.fromJson((e as Map).cast<String, Object?>()));
        }
      } on Object {
        // unreadable: start empty and leave the stored text alone until the next change
        list.clear();
      }
    }
    return Hosts._(v, list, await v.read(_lastSlot));
  }

  List<PairedHost> get all => List.unmodifiable(_all);

  PairedHost? byId(String id) => _all.where((h) => h.id == id).firstOrNull;

  /// `hostId port root` of the chat opened last on this phone.
  String? get lastChat => _lastChat;

  Future<void> _save() async {
    await _v.write(_slot, jsonEncode([for (final h in _all) h.toJson()]));
    notifyListeners();
  }

  /// Adds a host, or replaces the one with the same id in place.
  Future<void> add(PairedHost h) async {
    final i = _all.indexWhere((e) => e.id == h.id);
    if (i < 0) {
      _all.add(h);
    } else {
      h.customName ??= _all[i]
          .customName; // pairing again keeps the name chosen on this phone
      _all[i] = h;
    }
    await _save();
  }

  /// What the host's computer calls itself, learned on a connection. Changes nothing (and stays silent) when known.
  Future<void> learnComputerName(String id, String? name) async {
    final h = byId(id);
    final n = cleanHostName(name);
    if (h == null || n == null || h.computerName == n) return;
    h.computerName = n;
    await _save();
  }

  /// Renames a host on this phone only; an empty [name] or null goes back to the computer's name.
  Future<void> rename(String id, String? name) async {
    final h = byId(id);
    if (h == null) return;
    final n = name?.trim();
    // the name the list would show anyway is no rename: a later computer name must still come through
    h.customName =
        n == null || n.isEmpty || n == (h.computerName ?? h.fallbackLabel)
        ? null
        : n;
    await _save();
  }

  Future<void> forget(String id) async {
    _all.removeWhere((e) => e.id == id);
    if (_lastChat?.split(' ').first == id) await setLastChat(null);
    await _save();
  }

  Future<void> setLastChat(String? chat) async {
    _lastChat = chat;
    if (chat == null) {
      await _v.delete(_lastSlot);
    } else {
      await _v.write(_lastSlot, chat);
    }
  }
}
