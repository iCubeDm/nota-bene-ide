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
