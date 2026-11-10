import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/voice/outbox.dart';
import 'package:nb_app/voice/player.dart';
import 'package:nb_channel/nb_channel.dart' show HttpAnswer;
import 'package:nb_protocol/nb_protocol.dart';

import 'support/voice_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late MemoryOutFiles disk;
  late VoiceStore store;
  late List<ClientMessage> sent;
  late Completer<HttpAnswer>? upload;
  var open = true;
  final voiceJson = {'id': 'f' * 64, 'ms': 2000, 'wave': List.filled(48, 6)};
  final owner = Object();

  HttpAnswer ok() => (
    status: 200,
    headers: const <String, String>{},
    body: Uint8List.fromList(utf8.encode(jsonEncode(voiceJson))),
  );

  Future<HttpAnswer> post(
    String m,
    String p, {
    Map<String, String>? headers,
    List<int>? body,
  }) async => upload != null ? upload!.future : ok();

  VoiceOutbox attach([VoiceStore? s, Object? who]) {
    final box = (s ?? store).outbox('h/s1');
    box.attach(
      who ?? owner,
      send: (m) {
        sent.add(m);
        return open;
      },
      http: () => post,
    );
    return box;
  }

  setUp(() {
    disk = MemoryOutFiles();
    store = VoiceStore(disk);
    VoicePlayer.shared = VoicePlayer(files: MemoryVoiceFiles());
    sent = [];
    upload = null;
    open = true;
    VoiceOutbox.sentTimeout = const Duration(milliseconds: 80);
  });

  Future<void> settle() =>
      Future<void>.delayed(const Duration(milliseconds: 10));

  test('submit uploads, sends and persists the entry and its WAV', () async {
    final box = attach();
    box.submit(wavOf(2000), 'en');
    await settle();
    final m = sent.single as ClientMessageSend;
    expect(m.voice!.id, 'f' * 64);
    expect((m.text, m.lang), ('', 'en'));
    expect(box.entries.single.stage, OutStage.sent);
    expect(disk.wavs, hasLength(1));
    expect(jsonDecode(disk.index!)['entries'], hasLength(1));
    // the recording is cached under the host's id: playing it needs no download
    expect(await VoicePlayer.shared.files.find('f' * 64), isNotNull);
    box.detach(owner);
  });

  test('submit with force puts it on the send; a retry goes after', () async {
    final box = attach();
    box.submit(wavOf(2000), 'en', force: true);
    await settle();
    expect((sent.single as ClientMessageSend).force, isTrue);
    await Future<void>.delayed(const Duration(milliseconds: 120));
    expect(box.entries.single.stage, OutStage.failed);
    box.retry(box.entries.single);
    await settle();
    expect((sent.last as ClientMessageSend).force, isNull);
    box.detach(owner);
  });

  test(
    'leaving the chat during the upload loses nothing: the next open sends it',
    () async {
      upload = Completer<HttpAnswer>();
      var box = attach();
      box.submit(wavOf(2000), 'ru');
      await settle();
      box.detach(owner);
      upload!.complete(ok());
      await settle();
      expect(sent, isEmpty);
      expect(box.entries.single.stage, OutStage.uploading);
      expect(box.entries.single.voice, isNotNull);
      // the app dies and starts again
      final next = VoiceStore(disk);
      box = attach(next);
      await next.ready;
      expect(box.entries, hasLength(1));
      box.opened();
      await settle();
      final m = sent.single as ClientMessageSend;
      expect((m.voice!.id, m.lang), ('f' * 64, 'ru'));
      box.detach(owner);
    },
  );

  test('a death in the middle of the upload resumes the upload', () async {
    upload = Completer<HttpAnswer>();
    final box = attach();
    box.submit(wavOf(1000), 'en');
    await settle();
    box.detach(owner);
    final next = VoiceStore(disk);
    upload = null;
    final again = attach(next);
    await next.ready;
    expect(again.entries.single.voice, isNull);
    again.opened();
    await settle();
    expect(sent, hasLength(1));
    again.detach(owner);
  });

  test(
    'a failed bubble stays through leaving the chat, with Retry and Delete',
    () async {
      open = false;
      var box = attach();
      box.submit(wavOf(1000), 'en');
      await settle();
      expect(box.entries.single.stage, OutStage.failed);
      box.detach(owner);
      final next = VoiceStore(disk);
      box = attach(next);
      await next.ready;
      expect(box.entries.single.stage, OutStage.failed);
      open = true;
      box.retry(box.entries.single);
      await settle();
      expect(sent, hasLength(2));
      box.remove(box.entries.single);
      await settle();
      expect(disk.wavs, isEmpty);
      expect(jsonDecode(disk.index!)['entries'], isEmpty);
      box.detach(owner);
    },
  );

  test(
    'the window showing the message ends the entry and deletes its files',
    () async {
      final box = attach();
      box.submit(wavOf(1000), 'en');
      await settle();
      box.arrived((sent.single as ClientMessageSend).id);
      expect(box.entries, isEmpty);
      await settle();
      expect(disk.wavs, isEmpty);
      expect(jsonDecode(disk.index!)['entries'], isEmpty);
      box.detach(owner);
    },
  );

  test(
    'after a replay: shown ones are done, a sent one that is missing failed',
    () async {
      final box = attach();
      box.submit(wavOf(1000), 'en');
      box.submit(wavOf(1000), 'en');
      await settle();
      final first = (sent.first as ClientMessageSend).id;
      box.reconcile({first});
      expect(box.entries.single.stage, OutStage.failed);
      box.detach(owner);
    },
  );

  test(
    'a sent message the window never shows turns into a failed entry',
    () async {
      final box = attach();
      box.submit(wavOf(1000), 'en');
      await settle();
      expect(box.entries.single.stage, OutStage.sent);
      await Future<void>.delayed(const Duration(milliseconds: 120));
      expect(box.entries.single.stage, OutStage.failed);
      box.detach(owner);
    },
  );

  test('every entry has its own key, also after a restart', () async {
    final box = attach();
    box.submit(wavOf(1000), 'en');
    box.submit(wavOf(1000), 'en');
    final keys = {for (final e in box.entries) e.key};
    expect(keys, hasLength(2));
    expect(keys.every((k) => RegExp(r'^[0-9a-f-]{36}$').hasMatch(k)), isTrue);
    await settle();
    box.detach(owner);
  });

  test(
    'when the real bubble replaces the pending one, the player lets go of it',
    () async {
      final native = Player()..install();
      addTearDown(native.uninstall);
      final box = attach();
      box.submit(wavOf(1000), 'en');
      await settle();
      final e = box.entries.single;
      await VoicePlayer.shared.toggle(e.key, () async => wavOf(1000));
      expect(VoicePlayer.shared.id, e.key);
      box.arrived((sent.single as ClientMessageSend).id);
      await settle();
      expect(VoicePlayer.shared.id, isNull);
      box.detach(owner);
    },
  );
}
