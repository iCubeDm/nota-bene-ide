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

  test('every HTTP answer fixture round-trips', () {
    final answers = asMap(
      jsonDecode(
        File('../../shared/fixtures/protocol.json').readAsStringSync(),
      ),
    )['answers'];
    final parse = <String, Object? Function(Map<String, Object?>)>{
      'VcsDiff': VcsDiff.fromJson,
      'VcsPatch': VcsPatch.fromJson,
      'VcsLog': VcsLog.fromJson,
      'VcsCommitDetail': VcsCommitDetail.fromJson,
      'GitSwitchAnswer': GitSwitchAnswer.fromJson,
      'TreeEntry': TreeEntry.fromJson,
      'ProjectIconAnswer': ProjectIconAnswer.fromJson,
    };
    for (final MapEntry(:key, :value) in asMap(answers).entries) {
      for (final item in value as List) {
        if (key == 'CompleteAnswer') {
          expect(item, isA<List>());
          final CompleteAnswer hits = List<String>.from(item as List);
          expect(hits, item);
          continue;
        }
        final json = asMap(item);
        expect(
          (parse[key]!(json) as dynamic).toJson(),
          equals(json),
          reason: key,
        );
      }
    }
  });

  test('vcs answers parse to their variants', () {
    expect(VcsDiff.fromJson({'repo': false}), isA<VcsNoRepo>());
    expect(
      GitSwitchAnswer.fromJson({'error': 'busy'}),
      isA<GitSwitchRefusal>().having(
        (r) => r.error,
        'error',
        GitSwitchError.busy,
      ),
    );
    expect(GitSwitchAnswer.fromJson({'branch': 'main'}), isA<GitSwitched>());
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

  test('hasFeature: at, below and above its protocol, and with none', () {
    expect(hasFeature(Feature.voice.protocol, Feature.voice), isTrue);
    expect(hasFeature(Feature.voice.protocol - 1, Feature.voice), isFalse);
    expect(hasFeature(protocolVersion, Feature.voice), isTrue);
    expect(hasFeature(null, Feature.activity), isFalse);
  });
}
