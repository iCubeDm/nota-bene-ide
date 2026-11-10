import 'package:nb_channel/nb_channel.dart';
import 'package:test/test.dart';

void main() {
  test('a host name loses control and bidi-override characters', () {
    expect(cleanHostName('studio-mac'), 'studio-mac');
    expect(cleanHostName('  studio\u0000-\u001bmac\n '), 'studio-mac');
    expect(cleanHostName('a\u202Eb\u2066c\u200Fd\u061Ce'), 'abcde');
  });

  test('empty after cleaning is no name', () {
    expect(cleanHostName(null), isNull);
    expect(cleanHostName('   '), isNull);
    expect(cleanHostName('\u202E\u0007'), isNull);
  });

  test('a host name is capped at 64 characters, not splitting a character', () {
    expect(cleanHostName('a' * 100), 'a' * 64);
    expect(cleanHostName('😀' * 100), '😀' * 64);
  });
}
