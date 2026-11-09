// web/src/attachments/image.ts and its tests: what an image becomes before it is attached, and how it is uploaded.
import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:nb_app/chat/window_tab.dart';
import 'package:nb_app/hosts/host_link.dart';
import 'package:nb_app/media/attach.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_channel/nb_channel.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'support/fakes.dart';

Uint8List png(int w, int h) =>
    img.encodePng(img.Image(width: w, height: h, numChannels: 3));

/// Noise does not compress: a PNG of it is about as large as its pixels.
img.Image noise(int w, int h) {
  final r = math.Random(1);
  final im = img.Image(width: w, height: h, numChannels: 3);
  for (final p in im) {
    p
      ..r = r.nextInt(256)
      ..g = r.nextInt(256)
      ..b = r.nextInt(256);
  }
  return im;
}

(Uint8List, String)? _rangeError(Uint8List b, String m) =>
    throw RangeError('past the end');
(Uint8List, String)? _stateError(Uint8List b, String m) =>
    throw StateError('truncated');

void main() {
  group('prepareImage', () {
    test('4000x1000 is scaled to 1568 on the long edge and is a png', () async {
      final p = await prepareImage(png(4000, 1000), 'image/png');
      final d = img.decodePng(p.bytes)!;
      expect((d.width, d.height), (1568, 392));
      expect(p.mime, 'image/png');
    });

    test('a 12 MP photo comes out within the edge and the byte cap', () async {
      final jpg = img.encodeJpg(
        img.Image(width: 4000, height: 3000, numChannels: 3),
      );
      final p = await prepareImage(jpg, 'image/jpeg');
      final d = img.decodeImage(p.bytes)!;
      expect((d.width, d.height), (1568, 1176));
      expect(p.bytes.length, lessThanOrEqualTo(3500000));
    });

    test('a png over the byte limit falls back to jpeg', () async {
      final big = img.encodePng(noise(1500, 1100));
      expect(big.length, greaterThan(3500000));
      final p = await prepareImage(big, 'image/png');
      expect(p.mime, 'image/jpeg');
      expect(p.bytes.sublist(0, 3), [0xff, 0xd8, 0xff]);
      expect(p.bytes.length, lessThan(big.length));
    });

    test('a small png, jpeg or gif stays as it is', () async {
      final inputs = {
        'image/png': png(800, 600),
        'image/jpeg': img.encodeJpg(img.Image(width: 800, height: 600)),
        'image/gif': img.encodeGif(img.Image(width: 800, height: 600)),
      };
      for (final e in inputs.entries) {
        final p = await prepareImage(e.value, e.key);
        expect(p.bytes, e.value, reason: e.key);
        expect(p.mime, e.key);
      }
    });

    test('a photo turned by its orientation is re-encoded upright', () async {
      final im = img.Image(width: 3000, height: 1500, numChannels: 3)
        ..exif.imageIfd.orientation = 6;
      final p = await prepareImage(img.encodeJpg(im), 'image/jpeg');
      final d = img.decodeImage(p.bytes)!;
      expect((d.width, d.height), (784, 1568));
    });

    test('other types are refused', () async {
      await expectLater(
        prepareImage(png(8, 8), 'image/heic'),
        throwsA(isA<UnsupportedImage>()),
      );
      await expectLater(
        prepareImage(png(8, 8), 'application/pdf'),
        throwsA(isA<UnsupportedImage>()),
      );
    });

    test('any decode failure, an Error too, is an UnsupportedImage', () async {
      for (final f in [_rangeError, _stateError]) {
        await expectLater(
          prepareImage(png(8, 8), 'image/png', prepare: f),
          throwsA(isA<UnsupportedImage>()),
        );
      }
    });

    test('a truncated file is refused', () async {
      final whole = img.encodePng(noise(1700, 300));
      await expectLater(
        prepareImage(
          Uint8List.sublistView(whole, 0, whole.length ~/ 2),
          'image/png',
        ),
        throwsA(isA<UnsupportedImage>()),
      );
    });

    test('bytes that are not an image are refused', () async {
      await expectLater(
        prepareImage(Uint8List.fromList([1, 2, 3]), 'image/png'),
        throwsA(isA<UnsupportedImage>()),
      );
    });
  });

  group('uploadImage', () {
    final id = 'a' * 64;
    final prepared = Prepared(Uint8List.fromList([1, 2, 3]), 'image/jpeg');

    HttpAnswer answer(int status, Object body) => (
      status: status,
      headers: const <String, String>{},
      body: Uint8List.fromList(utf8.encode(jsonEncode(body))),
    );

    test(
      'posts the raw bytes to /attach and returns the id and type',
      () async {
        String? method, path;
        Map<String, String>? sentHeaders;
        List<int>? sentBody;
        final ref = await uploadImageVia(
          (m, p, {headers, body}) async {
            method = m;
            path = p;
            sentHeaders = headers;
            sentBody = body;
            return answer(200, {'id': id, 'mediaType': 'image/png'});
          },
          prepared,
          '[image 1]',
        );
        expect((method, path), ('POST', '/attach'));
        expect(sentHeaders, {'content-type': 'image/jpeg'});
        expect(sentBody, [1, 2, 3]);
        expect(ref.id, id);
        expect(ref.mediaType, ImageType.image_png);
        expect(ref.label, '[image 1]');
      },
    );

    test('a refusal or a bad reply is an AttachError', () async {
      await expectLater(
        uploadImageVia(
          (m, p, {headers, body}) async => answer(413, {'error': 'big'}),
          prepared,
          'x',
        ),
        throwsA(isA<AttachError>()),
      );
      await expectLater(
        uploadImageVia(
          (m, p, {headers, body}) async =>
              answer(200, {'id': id, 'mediaType': 'image/heic'}),
          prepared,
          'x',
        ),
        throwsA(isA<AttachError>()),
      );
    });

    test('a tab that is offline is an AttachError', () async {
      final link = HostLink(
        PairedHost(
          id: b64u(List.filled(32, 1)),
          relay: Uri.parse('wss://r.example'),
          label: 'h',
          pairedAt: DateTime(2026),
        ),
        FakeFactory().factory,
        await Identity.load(MemoryVault()),
      );
      final tab = WindowTab(link, 4791, '/home/u/notes', retry: (_) async {});
      await expectLater(
        uploadImage(tab, prepared, 'x'),
        throwsA(isA<AttachError>()),
      );
    });
  });
}
