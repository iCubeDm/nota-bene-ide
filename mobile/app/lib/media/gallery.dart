import 'package:flutter/services.dart';

import 'attach.dart' show imageTypes;
import 'picker.dart';

// The latest photos of the phone, through MainActivity's `nb/gallery` channel (MediaStore). Unlike the
// pickers this needs the photo permission, which the attach sheet asks for when it opens.
const galleryChannel = MethodChannel('nb/gallery');

/// How much of the gallery the app may read: everything, only what the user chose (Android 14's "selected photos") or nothing.
enum GalleryAccess { full, partial, denied }

/// One photo of the gallery, of a type the attach flow takes. The [id] is MediaStore's.
class GalleryItem {
  const GalleryItem({required this.id});
  final int id;

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

  /// [limit] items from [offset] of the list, newest first; fewer than [limit] means the end.
  Future<List<GalleryItem>> page(int offset, int limit);

  /// A square thumbnail of about [px] pixels (jpeg bytes); null when there is none.
  Future<Uint8List?> thumbnail(GalleryItem item, int px);

  /// The chosen items as files of ours, as the pickers answer them.
  Future<({List<PickedImage> images, List<String> skipped})> take(
    List<GalleryItem> items,
  );
}

class ChannelGallery implements GallerySource {
  // Scrolling back to a cell asks for its thumbnail again: the last ones are kept.
  final _thumbs = <(int, int), Uint8List>{};
  static const _kept = 240;

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
      return GalleryAccess.values.asNameMap()[r] ?? GalleryAccess.denied;
    } on PlatformException {
      return GalleryAccess.denied;
    } on MissingPluginException {
      return GalleryAccess.denied;
    }
  }

  @override
  Future<List<GalleryItem>> page(int offset, int limit) async {
    final r = await galleryChannel.invokeListMethod<Object?>('page', {
      'offset': offset,
      'limit': limit,
      // only the types the attach flow takes (no heic, say): the phone filters, so paging stays exact
      'mimes': imageTypes,
    });
    return [
      for (final m in r ?? const <Object?>[])
        if (m is Map && m['id'] is int) GalleryItem(id: m['id'] as int),
    ];
  }

  @override
  Future<Uint8List?> thumbnail(GalleryItem item, int px) async {
    final key = (item.id, px);
    final kept = _thumbs.remove(key);
    if (kept != null) return _thumbs[key] = kept;
    final b = await galleryChannel.invokeMethod<Uint8List>('thumbnail', {
      'id': item.id,
      'px': px,
    });
    if (b == null) return null;
    _thumbs[key] = b;
    if (_thumbs.length > _kept) _thumbs.remove(_thumbs.keys.first);
    return b;
  }

  @override
  Future<({List<PickedImage> images, List<String> skipped})> take(
    List<GalleryItem> items,
  ) async => parsePicked(
    await galleryChannel.invokeListMethod<Object?>('take', {
      'items': [
        for (final i in items) {'id': i.id},
      ],
    }),
  );
}

/// The source the sheet uses; replaced in tests.
GallerySource gallerySource = ChannelGallery();
