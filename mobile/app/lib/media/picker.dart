import 'dart:io';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter/services.dart';

// Images from the system: the camera app, the photo picker and the document picker, through MainActivity's `nb/pick`
// channel (an image is answered as {path, mime, name}). No permission of ours is involved; the system apps hand back only what the user chose.
const pickChannel = MethodChannel('nb/pick');

Future<Uint8List> defaultReadPickedFile(String path) =>
    File(path).readAsBytes();

Future<void> defaultDeletePickedFile(String path) async {
  try {
    await File(path).delete();
  } on FileSystemException {
    // already gone
  }
}

/// How a picked file is read and deleted; replaced in tests, where a file read cannot be waited for.
@visibleForTesting
Future<Uint8List> Function(String) readPickedFile = defaultReadPickedFile;
@visibleForTesting
Future<void> Function(String) deletePickedFile = defaultDeletePickedFile;

/// An image the system handed over: a file of ours in the cache (MainActivity copied it there, streaming), read only
/// when it is prepared and deleted after its use, so no picked image waits in memory.
class PickedImage {
  const PickedImage({
    required this.path,
    required this.mime,
    required this.name,
  });
  final String path;
  final String mime;
  final String name;

  Future<Uint8List> read() => readPickedFile(path);
  Future<void> delete() => deletePickedFile(path);
}

enum PickSource { camera, gallery, file }

/// What a pick answered: the images, the names of those the phone skipped as too large and of those it could not read.
typedef Picked = ({
  List<PickedImage> images,
  List<String> skipped,
  List<String> unreadable,
});

/// The images the user picked from [s] (none when cancelled).
Future<Picked> pickImages(PickSource s) async {
  return parsePicked(await pickChannel.invokeListMethod<Object?>(s.name));
}

/// A channel's answer to a pick: {path, mime, name} per image, {skipped: name} per image that was too large and
/// {unreadable: name} per one the phone could not read.
Picked parsePicked(List<Object?>? reply) {
  final images = <PickedImage>[];
  final skipped = <String>[], unreadable = <String>[];
  for (final item in reply ?? const <Object?>[]) {
    if (item is! Map) continue;
    final path = item['path'], mime = item['mime'], name = item['name'];
    if (item['skipped'] case final String n) {
      skipped.add(n);
    } else if (item['unreadable'] case final String n) {
      unreadable.add(n);
    } else if (path is String && mime is String && name is String) {
      images.add(PickedImage(path: path, mime: mime, name: name));
    }
  }
  return (images: images, skipped: skipped, unreadable: unreadable);
}

/// Hands [bytes] to the system's share sheet (an `ACTION_SEND` of a file in our cache, through the same provider as the
/// camera's); throws a [PlatformException] when there is nothing to share with.
Future<void> shareImage(Uint8List bytes, String mime, String name) =>
    pickChannel.invokeMethod<void>('share', {
      'bytes': bytes,
      'mime': mime,
      'name': name,
    });

/// The type of an image from its first bytes (png, jpeg, gif, webp), else from its [name], else any image.
String imageMime(Uint8List b, String name) {
  bool at(int i, List<int> m) =>
      b.length >= i + m.length &&
      [for (var k = 0; k < m.length; k++) b[i + k] == m[k]].every((x) => x);
  if (at(0, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) {
    return 'image/webp';
  }
  return switch (name.split('.').last.toLowerCase()) {
    'png' => 'image/png',
    'jpg' || 'jpeg' => 'image/jpeg',
    'gif' => 'image/gif',
    'webp' => 'image/webp',
    _ => 'image/*',
  };
}
