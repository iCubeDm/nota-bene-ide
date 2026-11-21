// A shell task's output as plain text, as the desktop shows it (web/src/plugins/tasks/ansi.ts, issue 573).

// ESC then: a CSI (colours, cursor), an OSC (titles, hyperlinks; ended by BEL or ST), or any other escape: intermediates,
// then one final byte
final _esc = RegExp(
  '\x1b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\x07\x1b]*(?:\x07|\x1b\\\\)?|[ -/]*[0-~])',
);
// the control characters left once the escapes are gone (all of C0 and DEL but tab, newline, carriage return, backspace)
final _ctrl = RegExp('[\x00-\x07\x0b\x0c\x0e-\x1f\x7f]');

/// A line after its backspaces: each one deletes the character before it.
String _backspaces(String line) {
  if (!line.contains('\b')) return line;
  final out = <int>[];
  for (final ch in line.runes) {
    if (ch == 8) {
      if (out.isNotEmpty) out.removeLast();
    } else {
      out.add(ch);
    }
  }
  return String.fromCharCodes(out);
}

/// Escape sequences removed, never interpreted; a carriage return rewinds its line (one that ends the line does not
/// blank it), CRLF is a newline, a backspace deletes the character before it. [truncated]: the tail began in the middle
/// of the output, so it may begin in the middle of an escape sequence (`2;32m…`).
String plainOutput(String raw, {bool truncated = false}) {
  final text = truncated
      ? raw.replaceFirst(RegExp(r'^[0-9;:?]+[@-~]'), '')
      : raw;
  return text
      .replaceAll(_esc, '')
      .replaceAll('\r\n', '\n')
      .split('\n')
      .map((line) {
        final l = line.replaceFirst(RegExp(r'\r+$'), '');
        return _backspaces(
          l.substring(l.lastIndexOf('\r') + 1),
        ).replaceAll(_ctrl, '');
      })
      .join('\n');
}
