import 'package:flutter/services.dart';

import 'attach.dart' show imageTypes;
import 'picker.dart';

// The latest photos of the phone, through MainActivity's `nb/gallery` channel (MediaStore). Unlike the
// pickers this needs the photo permission, which the attach sheet asks for when it opens.
const galleryChannel = MethodChannel('nb/gallery');

/// How much of the gallery the app may read: everything, only what the user chose (Android 14's "selected photos") or nothing.
enum GalleryAccess { full, partial, denied }

/// The most photos one choice holds; the phone copies no more (`MAX_PICK_COUNT` in MainActivity).
const maxAttachCount = 10;

/// One photo of the gallery, of a type the attach flow takes. The [id] is MediaStore's; [added] (seconds) with the id
/// is the place in the newest-first list, which is what the next page continues from.
class GalleryItem {
  const GalleryItem({required this.id, this.added = 0});
  final int id;
  final int added;

  @override
  bool operator ==(Object other) => other is GalleryItem && other.id == id;
  @override
  int get hashCode => id.hashCode;
}

/// Where the attach sheet gets the recent items; the channel in the app, a fake in tests.
abstract interface class GallerySource {
  /// The current access; with [ask] the system permission dialog is shown first when it can be. [settings] is for a
  /// tap on Grant access: when the system no longer shows the dialog, the app's own settings page is opened instead.
  Future<GalleryAccess> access({bool ask = false, bool settings = false});

  /// [limit] items after [after] (the first ones when null), newest first; fewer than [limit] means the end. The list
  /// is continued from an item, not an offset, so a photo taken meanwhile does not move the next page.
  Future<List<GalleryItem>> page(GalleryItem? after, int limit);

  /// A square thumbnail of about [px] pixels (jpeg bytes); null when there is none.
  Future<Uint8List?> thumbnail(GalleryItem item, int px);

  /// Drops the request of [thumbnail] for [item] at [px] if it has not started: its cell is gone.
  void cancel(GalleryItem item, int px);

  /// The chosen items as files of ours, as the pickers answer them.
  Future<Picked> take(List<GalleryItem> items);
}

class ChannelGallery implements GallerySource {
  // Scrolling back to a cell asks for its thumbnail again: the last ones are kept.
  final _thumbs = <(int, int), Uint8List>{};
  static const _kept = 240;
  // the thumbnails on their way, by a key the phone cancels them with
  final _flying = <(int, int), int>{};
  var _seq = 0;
  GalleryAccess? _last;

  @override
  Future<GalleryAccess> access({
    bool ask = false,
    bool settings = false,
  }) async {
    try {
      final r = await galleryChannel.invokeMethod<String>('access', {
        'ask': ask,
        'settings': settings,
      });
      return _seen(GalleryAccess.values.asNameMap()[r] ?? GalleryAccess.denied);
    } on PlatformException {
      return _seen(GalleryAccess.denied);
    } on MissingPluginException {
      return _seen(GalleryAccess.denied);
    }
  }

  // what changes with the access (other photos, other rights) is not what was cached
  GalleryAccess _seen(GalleryAccess a) {
    if (_last != null && _last != a) _thumbs.clear();
    return _last = a;
  }

  @override
  Future<List<GalleryItem>> page(GalleryItem? after, int limit) async {
    final r = await galleryChannel.invokeListMethod<Object?>('page', {
      'afterId': after?.id,
      'afterAdded': after?.added,
      'limit': limit,
      // only the types the attach flow takes (no heic, say): the phone filters, so a page is of what can be attached
      'mimes': imageTypes,
    });
    return [
      for (final m in r ?? const <Object?>[])
        if (m is Map && m['id'] is int)
          GalleryItem(id: m['id'] as int, added: (m['added'] as int?) ?? 0),
    ];
  }

  @override
  Future<Uint8List?> thumbnail(GalleryItem item, int px) async {
    final key = (item.id, px);
    final kept = _thumbs.remove(key);
    if (kept != null) return _thumbs[key] = kept;
    final flight = _flying[key] = ++_seq;
    try {
      final b = await galleryChannel.invokeMethod<Uint8List>('thumbnail', {
        'id': item.id,
        'px': px,
        'key': flight,
      });
      if (b == null) return null;
      _thumbs[key] = b;
      if (_thumbs.length > _kept) _thumbs.remove(_thumbs.keys.first);
      return b;
    } finally {
      if (_flying[key] == flight) _flying.remove(key);
    }
  }

  @override
  void cancel(GalleryItem item, int px) {
    final flight = _flying.remove((item.id, px));
    if (flight != null) {
      galleryChannel.invokeMethod<void>('cancel', {'key': flight}).ignore();
    }
  }

  @override
  Future<Picked> take(List<GalleryItem> items) async => parsePicked(
    await galleryChannel.invokeListMethod<Object?>('take', {
      'items': [
        for (final i in items) {'id': i.id},
      ],
    }),
  );
}

/// The source the sheet uses; replaced in tests.
GallerySource gallerySource = ChannelGallery();
