import 'dart:convert';
import 'dart:io';

import 'package:nb_protocol/nb_protocol.dart';
import 'package:test/test.dart';

Map<String, Object?> asMap(Object? v) => (v as Map).cast<String, Object?>();

List<Map<String, Object?>> fixtures(String key) {
  final doc = jsonDecode(
    File('../../shared/fixtures/protocol.json').readAsStringSync(),
  );
  return (asMap(doc)[key] as List).map(asMap).toList();
}

void main() {
  test('every fixture round-trips', () {
    for (final item in fixtures('client')) {
      expect(ClientMessage.fromJson(item).toJson(), equals(item));
    }
    for (final item in fixtures('server')) {
      expect(ServerEvent.fromJson(item).toJson(), equals(item));
    }
    for (final item in fixtures('usage')) {
      expect(UsageReport.fromJson(item).toJson(), equals(item));
    }
  });

  test('a nested replay parses to its own variants', () {
    final item = fixtures('server').firstWhere((e) => e['kind'] == 'replay');
    final replay = ServerEvent.fromJson(item) as ServerEventReplay;
    expect(replay.events[0], isA<ServerEventUser>());
    final agent = replay.events[1];
    expect(agent, isA<ServerEventAgent>());
    expect((agent as ServerEventAgent).e, isA<WireAgentEventMessage>());
  });

  test('an unknown event kind is kept, not thrown', () {
    final e = ServerEvent.fromJson({'kind': 'from-the-future', 'x': 1});
    expect(e, isA<ServerEventUnknown>());
    expect(e.toJson(), {'kind': 'from-the-future', 'x': 1});
  });

  test('an unknown enum value is \$unknown', () {
    final e =
        ServerEvent.fromJson({'kind': 'mode', 'mode': 'not-a-mode'})
            as ServerEventMode;
    expect(e.mode, AgentMode.$unknown);
  });

  test('\$unknown cannot be sent', () {
    expect(() => AgentMode.$unknown.toJson(), throwsStateError);
  });

  test('absent stays absent, null stays null', () {
    final send = fixtures('client').firstWhere((e) => e['type'] == 'send');
    expect(send.containsKey('force'), isFalse);
    expect(ClientMessage.fromJson(send).toJson().containsKey('force'), isFalse);
    final session = fixtures(
      'server',
    ).firstWhere((e) => e['kind'] == 'session');
    final out = ServerEvent.fromJson(session).toJson();
    expect(out.containsKey('title'), isTrue);
    expect(out['title'], isNull);
  });
}
