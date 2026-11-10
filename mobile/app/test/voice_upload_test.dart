import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/voice/upload.dart';
import 'package:nb_channel/nb_channel.dart' show HttpAnswer;
import 'package:nb_protocol/nb_protocol.dart' show VoiceError;

HttpAnswer reply(int status, [Object? body]) => (
  status: status,
  headers: const {},
  body: Uint8List.fromList(utf8.encode(body == null ? '' : jsonEncode(body))),
);

void main() {
  final id = 'a' * 64;
  final wav = Uint8List.fromList([1, 2, 3]);

  test('uploadVoice posts the WAV and reads the voice', () async {
    String? method, path;
    Map<String, String>? seen;
    List<int>? sent;
    final v = await uploadVoice((m, p, {headers, body}) async {
      method = m;
      path = p;
      seen = headers;
      sent = body;
      return reply(200, {'id': id, 'ms': 1200, 'wave': List.filled(48, 7)});
    }, wav);
    expect((method, path), ('POST', '/voice'));
    expect(seen!['content-type'], 'audio/wav');
    expect(sent, wav);
    expect((v.id, v.ms, v.wave.length), (id, 1200, 48));
  });

  test('uploadVoice throws on a refusal or a bad answer', () async {
    for (final r in [
      reply(413),
      reply(415),
      reply(400),
      reply(200, {'x': 1}),
    ]) {
      await expectLater(
        uploadVoice((m, p, {headers, body}) async => r, wav),
        throwsA(isA<VoiceUploadError>()),
        reason: '${r.status}',
      );
    }
    await expectLater(
      uploadVoice((m, p, {headers, body}) async => throw StateError('x'), wav),
      throwsA(isA<VoiceUploadError>()),
    );
  });

  test('transcribeClip: text, off on 503, failed otherwise', () async {
    String? path;
    final ok = await transcribeClip(
      (m, p, {headers, body}) async {
        path = p;
        return reply(200, {'text': ' hello '});
      },
      id,
      'ru',
    );
    expect(path, '/voice/$id/text?lang=ru');
    expect((ok.text, ok.error), ('hello', null));
    expect(
      (await transcribeClip(
        (m, p, {headers, body}) async => reply(503),
        id,
        'en',
      )).error,
      VoiceError.off,
    );
    expect(
      (await transcribeClip(
        (m, p, {headers, body}) async => reply(404),
        id,
        'en',
      )).error,
      VoiceError.failed,
    );
    expect(
      (await transcribeClip(
        (m, p, {headers, body}) async => reply(200, {'text': '  '}),
        id,
        'en',
      )).error,
      VoiceError.empty,
    );
  });
}
