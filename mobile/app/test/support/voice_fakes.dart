import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/audio_clip.dart';
import 'package:nb_app/comments/queue.dart';
import 'package:nb_app/media/fetch.dart';
import 'package:nb_app/sdk.dart';
import 'package:nb_app/store/storage.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_app/voice/outbox.dart';
import 'package:nb_app/voice/player.dart';
import 'package:nb_app/voice/recorder.dart';

/// A WAV of [ms] of [level] (0..1) 16 kHz mono PCM16, as `nb/record` answers.
Uint8List wavOf(int ms, {double level = .5}) {
  final n = ms * 16;
  final b = ByteData(44 + n * 2);
  void tag(int at, String s) {
    for (var i = 0; i < s.length; i++) {
      b.setUint8(at + i, s.codeUnitAt(i));
    }
  }

  tag(0, 'RIFF');
  b.setUint32(4, 36 + n * 2, Endian.little);
  tag(8, 'WAVEfmt ');
  b.setUint32(16, 16, Endian.little);
  b.setUint16(20, 1, Endian.little);
  b.setUint16(22, 1, Endian.little);
  b.setUint32(24, 16000, Endian.little);
  b.setUint32(28, 32000, Endian.little);
  b.setUint16(32, 2, Endian.little);
  b.setUint16(34, 16, Endian.little);
  tag(36, 'data');
  b.setUint32(40, n * 2, Endian.little);
  for (var i = 0; i < n; i++) {
    b.setInt16(44 + i * 2, (level * 32767).round(), Endian.little);
  }
  return b.buffer.asUint8List();
}

/// The files of the player, in memory: id -> bytes.
class MemoryVoiceFiles implements VoiceFiles {
  final files = <String, Uint8List>{};
  final saved = <String>[];

  @override
  Future<String?> find(String id) async =>
      files.containsKey(id) ? '/cache/voice/$id.wav' : null;

  @override
  Future<String> save(String id, Uint8List bytes) async {
    files[id] = bytes;
    saved.add(id);
    return '/cache/voice/$id.wav';
  }

  @override
  Future<void> delete(String id) async => files.remove(id);
}

/// The phone's player (`nb/play`), played by the test.
class Player {
  final calls = <MethodCall>[];

  /// What the player answers a call with (a `play`'s length in ms, say); none: null.
  Object? Function(MethodCall call)? answer;

  List<String> get names => [for (final c in calls) c.method];

  void install() => TestDefaultBinaryMessengerBinding
      .instance
      .defaultBinaryMessenger
      .setMockMethodCallHandler(playChannel, (call) async {
        calls.add(call);
        return answer?.call(call);
      });

  void uninstall() => TestDefaultBinaryMessengerBinding
      .instance
      .defaultBinaryMessenger
      .setMockMethodCallHandler(playChannel, null);

  /// The player reporting [ms] played, or its end.
  Future<void> call(String method, [Object? args]) =>
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .handlePlatformMessage(
            playChannel.name,
            playChannel.codec.encodeMethodCall(MethodCall(method, args)),
            (_) {},
          );
}

/// The phone's recorder (`nb/record`), played by the test.
class RecorderMock {
  final calls = <String>[];
  Object? startError;
  Uint8List? wav = wavOf(2000);
  Future<void> Function()? onStart;

  void install() => TestDefaultBinaryMessengerBinding
      .instance
      .defaultBinaryMessenger
      .setMockMethodCallHandler(recordChannel, (call) async {
        calls.add(call.method);
        if (call.method == 'start') {
          await onStart?.call();
          if (startError != null) {
            throw PlatformException(code: startError! as String);
          }
        }
        return call.method == 'stop' ? wav : null;
      });

  void uninstall() => TestDefaultBinaryMessengerBinding
      .instance
      .defaultBinaryMessenger
      .setMockMethodCallHandler(recordChannel, null);

  /// The recorder calling the phone back: `level`, `capped`, `failed`.
  Future<void> call(String method, [Object? args]) =>
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .handlePlatformMessage(
            recordChannel.name,
            recordChannel.codec.encodeMethodCall(MethodCall(method, args)),
            (_) {},
          );
}

/// What the stores keep in [MemoryFiles], by name: the voice outboxes' index and recordings, the comment queues.
extension StoredFiles on MemoryFiles {
  String? get index => values[VoiceStore.index] as String?;
  Iterable<String> get wavs => values.keys.where((k) => k.endsWith('.wav'));
  String? get json => values[CommentQueues.path] as String?;
  set json(String? v) => v == null
      ? values.remove(CommentQueues.path)
      : values[CommentQueues.path] = v;
}

/// The app's stores in memory: an empty vault and no files unless given (each call a fresh install), caching sent
/// voices in the player of the moment.
Future<AppStores> memoryStores({MemoryFiles? files}) => AppStores.load(
  Storage(MemoryVault(), files ?? MemoryFiles()),
  sounds: VoicePlayer.shared,
);

/// The clips' files, in memory: name -> bytes. Reads as the disk does: a body past [max], short of its length or
/// abandoned leaves nothing.
class MemoryClipFiles implements ClipFiles {
  final files = <String, List<int>>{};

  @override
  Future<Written> write(
    String name,
    Stream<List<int>> body, {
    required int max,
    int? length,
    Future<void>? abandoned,
  }) async {
    final all = <int>[];
    final end = Completer<FetchFail?>();
    late final StreamSubscription<List<int>> sub;
    void finish(FetchFail? f) {
      if (end.isCompleted) return;
      if (f != null) sub.cancel();
      end.complete(f);
    }

    sub = body.listen(
      (c) {
        all.addAll(c);
        if (all.length > max) finish(FetchFail.tooLarge);
      },
      onError: (Object _) => finish(FetchFail.unreadable),
      onDone: () => finish(
        length != null && all.length != length ? FetchFail.unreadable : null,
      ),
    );
    abandoned?.then((_) => finish(FetchFail.unreadable));
    final fail = await end.future;
    if (fail != null) return (path: null, fail: fail);
    files[name] = all;
    return (path: '/cache/clips/$name', fail: null);
  }
}
