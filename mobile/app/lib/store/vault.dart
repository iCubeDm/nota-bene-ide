// Where the phone keeps its key and its pairings: Android Keystore-backed storage (flutter_secure_storage), behind a
// small interface so tests run without the platform.
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

abstract class Vault {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

/// Stored data that cannot be read back. Never answered by silently starting over: that would lose the pairings.
class VaultCorrupt implements Exception {
  VaultCorrupt(this.key);
  final String key;
  @override
  String toString() => 'VaultCorrupt($key)';
}

class SecureVault implements Vault {
  // resetOnError: false — a decryption failure is reported, not answered by wiping the store
  final _s = const FlutterSecureStorage(
    aOptions: AndroidOptions(resetOnError: false),
  );

  @override
  Future<String?> read(String key) => _s.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _s.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _s.delete(key: key);
}

class MemoryVault implements Vault {
  final values = <String, String>{};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}
