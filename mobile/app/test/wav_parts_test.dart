import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/dictation/wav_parts.dart';

const _rate = 16000;

// a recording of [seconds] of loud sound (a square wave), silent over each of [quiet] (start, end in seconds)
Uint8List recording(double seconds, [List<(double, double)> quiet = const []]) {
  final n = (seconds * _rate).round();
  final b = ByteData(44 + n * 2);
  for (var i = 0; i < n; i++) {
    final s = i / _rate;
    final silent = quiet.any((q) => s >= q.$1 && s < q.$2);
    b.setInt16(
      44 + i * 2,
      silent
          ? 0
          : (i ~/ 20).isEven
          ? 9000
          : -9000,
      Endian.little,
    );
  }
  return b.buffer.asUint8List();
}

double seconds(Uint8List part) => (part.length - 44) / (_rate * 2);

String ascii(Uint8List b, int at) =>
    String.fromCharCodes(b.sublist(at, at + 4));

void main() {
  test('a recording up to a minute is sent as it is', () {
    final wav = recording(60);
    expect(splitWav(wav).single, same(wav));
  });

  test('a long recording is cut at its quiet moments, 30 to 60 s apart', () {
    final parts = splitWav(recording(150, [(44.9, 45.1), (94.9, 95.1)]));
    expect(parts.map(seconds).toList(), [
      closeTo(45, 0.1),
      closeTo(50, 0.1),
      closeTo(55, 0.1),
    ]);
  });

  test('no sample is lost or repeated between the parts', () {
    final wav = recording(130, [(40, 40.3), (100, 100.3)]);
    final joined = splitWav(wav).expand((p) => p.sublist(44)).toList();
    expect(joined, wav.sublist(44));
  });

  test('without a pause the parts still stay within 30 to 60 s', () {
    final parts = splitWav(recording(200));
    for (final p in parts.take(parts.length - 1)) {
      expect(seconds(p), inInclusiveRange(30, 60));
    }
    expect(seconds(parts.last), lessThanOrEqualTo(60));
  });

  test('the last part is never a short tail: 61 s goes as two halves', () {
    final parts = splitWav(recording(61, [(60.5, 61)]));
    expect(parts.map(seconds), everyElement(greaterThanOrEqualTo(30)));
  });

  test('each part is a WAV of its own: 16 kHz 16-bit mono', () {
    for (final p in splitWav(recording(90, [(50, 50.5)]))) {
      final b = ByteData.sublistView(p);
      expect(ascii(p, 0), 'RIFF');
      expect(b.getUint32(4, Endian.little), p.length - 8);
      expect(ascii(p, 8), 'WAVE');
      expect(ascii(p, 12), 'fmt ');
      expect(b.getUint16(20, Endian.little), 1);
      expect(b.getUint16(22, Endian.little), 1);
      expect(b.getUint32(24, Endian.little), 16000);
      expect(b.getUint32(28, Endian.little), 32000);
      expect(b.getUint16(34, Endian.little), 16);
      expect(ascii(p, 36), 'data');
      expect(b.getUint32(40, Endian.little), p.length - 44);
    }
  });
}
