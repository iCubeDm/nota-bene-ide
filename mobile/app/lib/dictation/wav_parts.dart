// A long recording cut into parts the window's Whisper takes one request each (host_dictation.dart): a part ends at
// the quietest moment between 30 and 60 s into it, so a word is not split between two parts.
import 'dart:typed_data';

// 16 kHz 16-bit mono after the recorder's 44-byte header
const _header = 44;
const _perSecond = 32000;
const _partMin = 30 * _perSecond, _partMax = 60 * _perSecond;

// the loudness is summed per 50 ms; the quietest 250 ms is where the part ends, in its middle
const _frame = _perSecond ~/ 20;
const _window = 5;

List<Uint8List> splitWav(Uint8List wav) {
  final pcm = wav.length - _header;
  if (pcm <= _partMax) return [wav];
  final data = ByteData.sublistView(wav, _header);
  final parts = <Uint8List>[];
  var start = 0;
  while (pcm - start > _partMax) {
    // the last part keeps at least 30 s too: Whisper makes words up for a short tail of silence
    final hi = pcm - start < _partMax + _partMin
        ? (pcm - _partMin).clamp(start + _partMin, start + _partMax)
        : start + _partMax;
    final end = _quietest(data, start + _partMin, hi);
    parts.add(_wav(wav, start, end));
    start = end;
  }
  parts.add(_wav(wav, start, pcm));
  return parts;
}

// The middle of the quietest window in [lo, hi): the later one of equals, for fewer parts.
int _quietest(ByteData pcm, int lo, int hi) {
  final frames = List<int>.generate((hi - lo) ~/ _frame, (f) {
    var sum = 0;
    for (var o = lo + f * _frame; o < lo + (f + 1) * _frame; o += 2) {
      sum += pcm.getInt16(o, Endian.little).abs();
    }
    return sum;
  });
  var energy = frames.take(_window).fold(0, (a, b) => a + b);
  var best = 0, least = energy;
  for (var i = 1; i + _window <= frames.length; i++) {
    energy += frames[i + _window - 1] - frames[i - 1];
    if (energy <= least) (best, least) = (i, energy);
  }
  return lo + best * _frame + _window * _frame ~/ 2;
}

Uint8List _wav(Uint8List src, int from, int to) {
  final n = to - from;
  final out = Uint8List(_header + n)
    ..setRange(_header, _header + n, src, _header + from);
  final b = ByteData.sublistView(out);
  void tag(int at, String s) => out.setRange(at, at + 4, s.codeUnits);
  tag(0, 'RIFF');
  b.setUint32(4, 36 + n, Endian.little);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  b
    ..setUint32(16, 16, Endian.little)
    ..setUint16(20, 1, Endian.little)
    ..setUint16(22, 1, Endian.little)
    ..setUint32(24, 16000, Endian.little)
    ..setUint32(28, _perSecond, Endian.little)
    ..setUint16(32, 2, Endian.little)
    ..setUint16(34, 16, Endian.little);
  tag(36, 'data');
  b.setUint32(40, n, Endian.little);
  return out;
}
