// The played voices on the phone, in the cache dir `nb/play` names (`dir`). Apart from the player, so that the voice
// outboxes that keep files there need not import it.
import 'dart:io';

import 'package:flutter/services.dart';

import '../store/storage.dart' show playChannel;

/// What the voice outboxes ask of the player: keep a sent recording among the played voices, and let go of one that
/// is over (stopped if it plays, its file deleted).
abstract interface class Sounds {
  VoiceFiles get files;
  Future<void> drop(String voice);
}

/// The WAVs the player has, by voice id.
abstract class VoiceFiles {
  Future<String?> find(String id);
  Future<String> save(String id, Uint8List bytes);
  Future<void> delete(String id);
}

/// In the app's cache dir (the platform clears it when it needs room); the same voice is fetched once.
class DiskVoiceFiles implements VoiceFiles {
  Future<File> _file(String id) async {
    final dir = await playChannel.invokeMethod<String>('dir');
    return File('$dir/${id.replaceAll(RegExp(r'[^0-9A-Za-z_-]'), '_')}.wav');
  }

  @override
  Future<String?> find(String id) async {
    final f = await _file(id);
    return await f.exists() ? f.path : null;
  }

  @override
  Future<String> save(String id, Uint8List bytes) async {
    final f = await _file(id);
    // written aside and renamed: a half-written file must never be taken for the voice
    final part = File('${f.path}.part');
    await part.writeAsBytes(bytes, flush: true);
    await part.rename(f.path);
    return f.path;
  }

  @override
  Future<void> delete(String id) async {
    final f = await _file(id);
    if (await f.exists()) await f.delete();
  }
}
