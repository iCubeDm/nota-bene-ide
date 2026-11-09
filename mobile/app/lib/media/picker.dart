import 'package:flutter/services.dart';

// Images from the system: the camera app, the photo picker and the document picker, through MainActivity's `nb/pick`
// channel. No permission of ours is involved; the system apps hand back only what the user chose.
const pickChannel = MethodChannel('nb/pick');

class PickedImage {
  const PickedImage({
    required this.bytes,
    required this.mime,
    required this.name,
  });
  final Uint8List bytes;
  final String mime;
  final String name;
}

enum PickSource { camera, gallery, file }

/// The images the user picked from [s] (none when cancelled) and the names of those the phone skipped as too large.
Future<({List<PickedImage> images, List<String> skipped})> pickImages(
  PickSource s,
) async {
  final reply = await pickChannel.invokeListMethod<Object?>(s.name);
  final images = <PickedImage>[];
  final skipped = <String>[];
  for (final item in reply ?? const <Object?>[]) {
    if (item is! Map) continue;
    final bytes = item['bytes'], mime = item['mime'], name = item['name'];
    if (item['skipped'] case final String n) {
      skipped.add(n);
    } else if (bytes is Uint8List && mime is String && name is String) {
      images.add(PickedImage(bytes: bytes, mime: mime, name: name));
    }
  }
  return (images: images, skipped: skipped);
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
