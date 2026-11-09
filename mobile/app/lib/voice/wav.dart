// What the phone reads of its own recording (16 kHz 16-bit mono after a 44-byte header, as `nb/record` writes it):
// the length and the 48 bars the host would draw, for a bubble shown before the upload has answered.
import 'dart:typed_data';

const wavHeader = 44;
const voiceBars = 48;

/// 32 bytes a millisecond.
int wavMs(Uint8List wav) => (wav.length - wavHeader).clamp(0, 1 << 30) ~/ 32;

/// The peak of each of 48 equal slices, the loudest scaled to 31; silence is all zeros (the host's `waveOf`).
List<int> waveOf(Uint8List wav) {
  final samples = (wav.length - wavHeader).clamp(0, 1 << 30) ~/ 2;
  final pcm = ByteData.sublistView(wav, wavHeader.clamp(0, wav.length));
  final peaks = List.filled(voiceBars, 0);
  var loudest = 0;
  for (var i = 0; i < voiceBars; i++) {
    final from = samples * i ~/ voiceBars;
    var to = samples * (i + 1) ~/ voiceBars;
    if (to <= from && from < samples) to = from + 1;
    var peak = 0;
    for (var k = from; k < to; k++) {
      final v = pcm.getInt16(k * 2, Endian.little).abs();
      if (v > peak) peak = v;
    }
    peaks[i] = peak;
    if (peak > loudest) loudest = peak;
  }
  return [for (final p in peaks) loudest == 0 ? 0 : (p * 31 / loudest).round()];
}
