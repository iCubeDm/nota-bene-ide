import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/notify/platform.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const codec = StandardMethodCodec();
  late List<MethodCall> calls;

  setUp(() {
    calls = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(backgroundChannel, (c) async {
          calls.add(c);
          return switch (c.method) {
            'permission' => 'ask',
            'requestPermission' => true,
            'takeLaunch' => {'hostId': 'h', 'port': 4791, 'root': '/r'},
            _ => null,
          };
        });
  });

  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(backgroundChannel, null),
  );

  /// A call from Android to Dart on the channel; the answer it gets.
  Future<Object?> fromNative(String method, [Object? args]) {
    final done = Completer<Object?>();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .handlePlatformMessage(
          backgroundChannel.name,
          codec.encodeMethodCall(MethodCall(method, args)),
          (reply) =>
              done.complete(reply == null ? null : codec.decodeEnvelope(reply)),
        );
    return done.future;
  }

  test('each method sends its name and arguments', () async {
    final p = ChannelBackground();
    expect(await p.permission(), 'ask');
    expect(await p.requestPermission(), isTrue);
    await p.startService('Nota Bene', '1 agent working', 'Connection');
    await p.updateService('Nota Bene', '2 agents working');
    await p.notify(
      tag: 'h s1',
      title: 'notes',
      text: 'done',
      publicTitle: 'New reply in notes',
      hostId: 'h',
      port: 4791,
      root: '/r',
      channelName: 'Agents',
    );
    await p.cancel('h s1');
    await p.schedule(true);
    await p.stopService();
    await p.openSettings();
    await p.done();
    expect(await p.takeLaunch(), (hostId: 'h', port: 4791, root: '/r'));
    expect(
      [for (final c in calls) c.method],
      [
        'permission',
        'requestPermission',
        'startService',
        'updateService',
        'notify',
        'cancel',
        'schedule',
        'stopService',
        'openSettings',
        'done',
        'takeLaunch',
      ],
    );
    expect(calls[2].arguments, {
      'title': 'Nota Bene',
      'text': '1 agent working',
      'channel': 'Connection',
    });
    expect(calls[4].arguments, {
      'tag': 'h s1',
      'title': 'notes',
      'text': 'done',
      'publicTitle': 'New reply in notes',
      'hostId': 'h',
      'port': 4791,
      'root': '/r',
      'channel': 'Agents',
    });
    expect(calls[5].arguments, {'tag': 'h s1'});
    expect(calls[6].arguments, {'on': true});
  });

  test('a tapped notification reaches the opened stream', () async {
    final p = ChannelBackground();
    final got = p.opened.first;
    await fromNative('opened', {'hostId': 'h', 'port': 4791, 'root': '/r'});
    expect(await got, (hostId: 'h', port: 4791, root: '/r'));
  });

  test(
    'a check from Android runs the registered check and answers after it',
    () async {
      final p = ChannelBackground();
      final gate = Completer<void>();
      var ran = false;
      p.onCheck(() async {
        ran = true;
        await gate.future;
      });
      var answered = false;
      final reply = fromNative('check').then((_) => answered = true);
      await Future<void>.delayed(Duration.zero);
      expect(ran, isTrue);
      expect(answered, isFalse);
      gate.complete();
      await reply;
      expect(answered, isTrue);
    },
  );
}
