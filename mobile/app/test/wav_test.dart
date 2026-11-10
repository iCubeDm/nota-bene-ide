import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/voice/wav.dart';

import 'support/voice_fakes.dart';

void main() {
  test('the length of a 16 kHz mono PCM16 WAV in ms', () {
    expect(wavMs(wavOf(1500)), 1500);
    expect(wavMs(Uint8List(10)), 0);
  });

  test('48 bars, the loudest 31, silence all zeros', () {
    final w = waveOf(wavOf(500));
    expect(w, hasLength(48));
    expect(w.reduce((a, b) => a > b ? a : b), 31);
    expect(waveOf(wavOf(500, level: 0)), everyElement(0));
  });

  test('a ramp is non-decreasing, a short recording still has 48 bars', () {
    final b = ByteData(44 + 480 * 2);
    for (var i = 0; i < 480; i++) {
      b.setInt16(44 + i * 2, i * 60, Endian.little);
    }
    final w = waveOf(b.buffer.asUint8List());
    expect(w, hasLength(48));
    for (var i = 1; i < 48; i++) {
      expect(w[i], greaterThanOrEqualTo(w[i - 1]));
    }
  });
}
