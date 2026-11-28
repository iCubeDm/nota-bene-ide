// The composer's draft is the window's, per session (issue 174): every client of the window shows the open session's
// draft and the last write to arrive wins (no merge, no revision: one socket's frames are ordered). The rule is the
// desktop's (web/src/plugins/composer/draftSync.ts) without a switch of its own: the phone sends none.
import 'dart:async';
import 'dart:math' show min;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'agent_connection.dart' show uuidV4;
import 'markdown_text.dart';

/// The longest text a draft write carries (`DRAFT_MAX`); a longer one stays on the phone.
const draftMax = 256 * 1024;

/// At most one write this often: the first of a burst at once, the last after it.
const draftThrottle = Duration(milliseconds: 300);

/// An image of the draft: one uploaded here or by another client ([ref]), or one being prepared and uploaded here
/// ([bytes], the thumbnail; null until prepared), which is not in the window's draft until its upload is done.
class DraftPicture {
  DraftPicture({this.ref});
  Uint8List? bytes;
  ImageRef? ref;

  /// The upload did not work: the image stays, marked, until the user removes it.
  bool failed = false;
  bool get pending => ref == null && !failed;
}

class DraftSync extends ChangeNotifier {
  DraftSync({
    required bool Function(ClientMessage) send,
    required bool Function(Feature) has,
    this.throttle = draftThrottle,
  }) : _send = send,
       _has = has {
    text.addListener(_edited);
  }

  final bool Function(ClientMessage) _send;
  final bool Function(Feature) _has;
  final Duration throttle;

  /// The draft's text, as the composer edits it.
  final text = MarkdownText();

  List<DraftPicture> _pictures = [];

  /// The draft's images, in order; they tell by [notifyListeners].
  List<DraftPicture> get pictures => List.unmodifiable(_pictures);

  /// The session of the last draft taken: the writes are tagged with it. Unset ([_scoped] false) before the first.
  String? _scope;
  bool _scoped = false;

  /// The id of the last write the window has not acked.
  String? _pending;

  /// Local edits since that write.
  bool _dirty = false;

  /// The text as last seen: a change of selection alone is no edit.
  String _seen = '';
  bool _applying = false;
  Timer? _timer;
  DateTime? _last;

  void _edited() {
    if (text.text == _seen) return;
    _seen = text.text;
    if (_applying) return;
    _dirty = true;
    _soon();
  }

  /// An image added here (an upload starting, or a refused send's images coming back).
  void add(DraftPicture p) => addAll([p]);

  void addAll(List<DraftPicture> ps) {
    _pictures = [..._pictures, ...ps];
    if (ps.any((p) => p.ref != null)) _local();
    notifyListeners();
  }

  /// [p]'s upload is done ([DraftPicture.ref] set): it is in the draft now. Also a failure, to show it.
  void uploaded(DraftPicture p) {
    if (p.ref != null) _local();
    notifyListeners();
  }

  void remove(DraftPicture p) => removeAll([p]);

  void removeAll(List<DraftPicture> ps) {
    final gone = ps.toSet();
    if (!_pictures.any(gone.contains)) return;
    if (gone.any((p) => p.ref != null)) _local();
    _pictures = [
      for (final p in _pictures)
        if (!gone.contains(p)) p,
    ];
    notifyListeners();
  }

  /// A send went: its text and [ps] leave the draft in one write, now.
  void sent(List<DraftPicture> ps) {
    final gone = ps.toSet();
    _pictures = [
      for (final p in _pictures)
        if (!gone.contains(p)) p,
    ];
    _applying = true;
    try {
      text.clear();
    } finally {
      _applying = false;
    }
    _dirty = true;
    flush();
    notifyListeners();
  }

  void _local() {
    _dirty = true;
    _soon();
  }

  void _soon() {
    if (_timer != null || !_dirty) return;
    final last = _last;
    final wait = last == null
        ? Duration.zero
        : last.add(throttle).difference(DateTime.now());
    if (wait <= Duration.zero) {
      flush();
    } else {
      _timer = Timer(wait, flush);
    }
  }

  /// Writes the local edits now, when there are some and the window takes drafts (after its hello): a send, the app
  /// going to the background, the chat closing.
  void flush() {
    _timer?.cancel();
    _timer = null;
    // below the floor (41) no window opens: `has` here means the window said hello
    if (!_dirty || !_has(Feature.draft)) return;
    final id = _put(_scope);
    if (id == null) return;
    _pending = id;
    _dirty = false;
    _last = DateTime.now();
  }

  /// The write's id, or null when it did not go (offline, or a text over [draftMax]: it stays here).
  String? _put(String? sessionId) {
    if (text.text.length > draftMax) return null;
    final id = uuidV4();
    final images = [
      for (final p in _pictures)
        if (p.ref case final r?) DraftImage(id: r.id, mediaType: r.mediaType),
    ];
    final sent = _send(
      ClientMessageDraft(
        id: id,
        sessionId: sessionId,
        text: text.text,
        images: images.isEmpty ? null : images,
      ),
    );
    return sent ? id : null;
  }

  /// The window's draft, after a write (its [ServerEventDraft.ack]) or as its state:
  /// - this phone's own echo: the wait ends and the text stays, so the caret never moves;
  /// - the same session (or the first, or an id-less one getting its id): applied only while clean, else the next
  ///   write here wins;
  /// - another session (a switch, a /clear, a fork, from any client): a dirty text goes to the old session first (kept
  ///   here when it cannot go, a text over [draftMax]).
  /// One without ack is the window's state, not someone's write: it ends a wait no ack will answer.
  void received(ServerEventDraft e) {
    if (e.ack != null && e.ack == _pending) {
      _scope = e.sessionId;
      _scoped = true;
      _pending = null;
      return;
    }
    if (!_scoped || _scope == null || e.sessionId == _scope) {
      final clean = _pending == null && !_dirty;
      if (e.ack == null) _pending = null;
      _scope = e.sessionId;
      _scoped = true;
      if (clean) _apply(e);
    } else {
      final old = _scope;
      _scope = e.sessionId;
      _pending = null;
      if (!_dirty || _put(old) != null) {
        _dirty = false;
        _apply(e);
      }
    }
    _soon();
  }

  /// A new socket said hello: what was typed offline, or before the attach draft, goes now.
  void hello() => flush();

  /// The socket is gone: a write it did not ack is lost with it, so the text is dirty again.
  void closed() {
    if (_pending == null) return;
    _pending = null;
    _dirty = true;
  }

  void _apply(ServerEventDraft e) {
    final kept = {
      for (final p in _pictures)
        if (p.ref case final r?) r.id: p,
    };
    _pictures = [
      for (final i in e.images ?? const <DraftImage>[])
        kept[i.id] ??
            DraftPicture(
              ref: ImageRef(id: i.id, mediaType: i.mediaType, label: ''),
            ),
      // an upload in flight here is not in anyone's draft yet
      for (final p in _pictures)
        if (p.ref == null) p,
    ];
    _applying = true;
    try {
      text.value = applied(text.value, e.text);
    } finally {
      _applying = false;
    }
    notifyListeners();
  }

  @override
  void dispose() {
    flush();
    _timer?.cancel();
    text.dispose();
    super.dispose();
  }
}

/// [v] changed to [next] by the smallest change (the common start and end kept), its selection mapped across it: the
/// caret stays by its words. Into an empty field the caret goes to the end.
@visibleForTesting
TextEditingValue applied(TextEditingValue v, String next) {
  final old = v.text;
  if (old == next) return v;
  if (old.isEmpty) {
    return TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: next.length),
    );
  }
  final most = min(old.length, next.length);
  var start = 0;
  while (start < most && old.codeUnitAt(start) == next.codeUnitAt(start)) {
    start++;
  }
  var end = 0;
  while (end < most - start &&
      old.codeUnitAt(old.length - 1 - end) ==
          next.codeUnitAt(next.length - 1 - end)) {
    end++;
  }
  // never inside a surrogate pair
  if (start > 0 && _high(old.codeUnitAt(start - 1))) start--;
  if (end > 0 && _low(old.codeUnitAt(old.length - end))) end--;
  int map(int o) {
    if (o <= start) return o;
    if (o >= old.length - end) return o + next.length - old.length;
    return next.length - end;
  }

  final s = v.selection;
  return TextEditingValue(
    text: next,
    selection: s.isValid
        ? s.copyWith(
            baseOffset: map(s.baseOffset),
            extentOffset: map(s.extentOffset),
          )
        : TextSelection.collapsed(offset: next.length),
  );
}

bool _high(int c) => c >= 0xD800 && c <= 0xDBFF;
bool _low(int c) => c >= 0xDC00 && c <= 0xDFFF;
