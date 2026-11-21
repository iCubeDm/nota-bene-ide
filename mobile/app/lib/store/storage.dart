// The phone's storage (issue 547), as the web's `storage` (web/src/sdk/storage.ts): one data-access interface for what
// outlives the app, which the stores are built on. [Storage.vault] keeps small values by key (Keystore-backed, the
// web's `storage.local`); [Storage.files] the larger ones in the app's files dir, by path: the comment queues
// (`comment-ops.json`) and the voice outboxes (`voice-out/index.json`, `voice-out/<entry>.wav`). The phone has no
// `storage.pref`: its settings are its own, not a host's. Tests use [Storage.memory].
import 'dart:io';
import 'dart:typed_data';

import '../voice/files.dart' show outDir;
import 'vault.dart';

class Storage {
  Storage(this.vault, this.files);

  /// Nothing kept beyond the object: a fresh install.
  Storage.memory() : vault = MemoryVault(), files = MemoryFiles();

  final Vault vault;
  final Files files;
}

/// Files by a path relative to the app's files dir.
abstract class Files {
  Future<String?> readText(String path);

  /// Written whole: aside first, then renamed over the old one.
  Future<void> writeText(String path, String text);
  Future<Uint8List?> readBytes(String path);
  Future<void> writeBytes(String path, Uint8List bytes);
  Future<void> delete(String path);
}

/// The app's files dir (the parent of `nb/play`'s `outDir`); where the platform has none (tests), nothing is kept.
class DiskFiles implements Files {
  Future<File?> _file(String path) async {
    final d = await outDir();
    return d == null ? null : File('${d.parent.path}/$path');
  }

  @override
  Future<String?> readText(String path) async {
    final f = await _file(path);
    return f != null && await f.exists() ? f.readAsString() : null;
  }

  @override
  Future<void> writeText(String path, String text) async {
    final f = await _file(path);
    if (f == null) return;
    final part = File('${f.path}.part');
    await part.writeAsString(text, flush: true);
    await part.rename(f.path);
  }

  @override
  Future<Uint8List?> readBytes(String path) async {
    final f = await _file(path);
    return f != null && await f.exists() ? f.readAsBytes() : null;
  }

  @override
  Future<void> writeBytes(String path, Uint8List bytes) async {
    await (await _file(path))?.writeAsBytes(bytes, flush: true);
  }

  @override
  Future<void> delete(String path) async {
    final f = await _file(path);
    if (f != null && await f.exists()) await f.delete();
  }
}

class MemoryFiles implements Files {
  /// Path -> a String (text) or a Uint8List (bytes).
  final values = <String, Object>{};

  @override
  Future<String?> readText(String path) async => values[path] as String?;

  @override
  Future<void> writeText(String path, String text) async => values[path] = text;

  @override
  Future<Uint8List?> readBytes(String path) async => values[path] as Uint8List?;

  @override
  Future<void> writeBytes(String path, Uint8List bytes) async =>
      values[path] = bytes;

  @override
  Future<void> delete(String path) async => values.remove(path);
}
