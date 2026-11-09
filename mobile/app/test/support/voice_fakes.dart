import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
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

  List<String> get names => [for (final c in calls) c.method];

  void install() => TestDefaultBinaryMessengerBinding
      .instance
      .defaultBinaryMessenger
      .setMockMethodCallHandler(playChannel, (call) async {
        calls.add(call);
        return null;
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

/// The outbox's disk, in memory; a second [VoiceStore] over the same files is the next run of the app.
class MemoryOutFiles implements OutFiles {
  String? index;
  final wavs = <String, Uint8List>{};

  @override
  Future<String?> readIndex() async => index;

  @override
  Future<void> writeIndex(String json) async => index = json;

  @override
  Future<void> writeWav(String name, Uint8List bytes) async =>
      wavs[name] = bytes;

  @override
  Future<Uint8List?> readWav(String name) async => wavs[name];

  @override
  Future<void> deleteWav(String name) async => wavs.remove(name);
}
