// The stores over the phone's storage (issue 547): what an installed app kept before is read back as it was, from the
// same vault keys and the same files.
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/sdk.dart';
import 'package:nb_app/store/storage.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_app/voice/player.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('the stores read what the app kept before, in its old format', () async {
    final v = MemoryVault()
      ..values.addAll({
        'nb.hosts':
            '[{"id":"aG9zdA","relay":"wss://r.example","label":"notes","pairedAt":"2026-01-02T03:04:05.000Z","computerName":"desk","customName":"Work"}]',
        'nb.lastChat': 'aG9zdA w1',
        'nb.notified': '{"aG9zdA":{"s1":{"r":2,"w":true}}}',
        'nb.notify': 'off',
      });
    final files = MemoryFiles()
      ..values.addAll({
        'comment-ops.json':
            '{"aG9zdA|s1":[{"type":"comment-op","opId":"o1","sessionId":"s1","ops":[{"op":"remove","id":"c1"}]}]}',
        'voice-out/index.json':
            '{"entries":[{"box":"aG9zdA|s1","key":"k1","lang":"en","ms":1200,"wave":[0.5],"id":"i1","stage":"failed"}]}',
        'voice-out/k1.wav': Uint8List.fromList([1, 2, 3]),
      });
    final s = await AppStores.load(
      Storage(v, files),
      sounds: VoicePlayer.shared,
    );

    final h = s.hosts.all.single;
    expect((h.id, h.label, h.computerName), ('aG9zdA', 'Work', 'desk'));
    expect(h.pairedAt, DateTime.utc(2026, 1, 2, 3, 4, 5));
    expect(s.hosts.lastChat, 'aG9zdA w1');
    expect(s.notified.of('aG9zdA', 's1'), (
      replies: 2,
      waiting: true,
      unseen: null,
    ));
    expect(s.notify.on, isFalse);

    await s.comments.ready;
    expect(s.comments.of('aG9zdA|s1').ops.single.opId, 'o1');
    await s.voice.ready;
    final e = s.voice.outbox('aG9zdA|s1').entries.single;
    expect((e.key, e.ms, e.stage.name), ('k1', 1200, 'failed'));
  });

  test('on the phone, the files are where they always were', () async {
    final dir = await Directory.systemTemp.createTemp('nb-files');
    addTearDown(() => dir.delete(recursive: true));
    final out = Directory('${dir.path}/voice-out')..createSync();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          playChannel,
          (c) async => c.method == 'outDir' ? out.path : null,
        );
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(playChannel, null),
    );
    final f = DiskFiles();
    await f.writeText('comment-ops.json', '{}');
    await f.writeText('voice-out/index.json', '{"entries":[]}');
    await f.writeBytes('voice-out/k1.wav', Uint8List.fromList([7]));
    expect(File('${dir.path}/comment-ops.json').readAsStringSync(), '{}');
    expect(File('${out.path}/index.json').existsSync(), isTrue);
    expect(File('${out.path}/k1.wav').readAsBytesSync(), [7]);
    expect(await f.readBytes('voice-out/k1.wav'), [7]);
    await f.delete('voice-out/k1.wav');
    expect(File('${out.path}/k1.wav').existsSync(), isFalse);
    expect(dir.listSync().map((e) => e.path.split('/').last).toSet(), {
      'comment-ops.json',
      'voice-out',
    });
  });
}
