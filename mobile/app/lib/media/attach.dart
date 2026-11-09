// web/src/attachments/image.ts: an image is scaled to [imgEdge] on its long edge and re-encoded when it is too big,
// small png/jpeg/gif/webp stay as they are; then POST /attach with the raw bytes (the id is the content hash).
import 'dart:convert';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:image/image.dart' as img;
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/window_tab.dart';
import '../files/image_screen.dart';
import 'media_comment.dart';
import 'render.dart';

/// What `/attach` takes.
const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

class Prepared {
  const Prepared(this.bytes, this.mime);
  final Uint8List bytes;
  final String mime;
}

/// The file is not a png, jpeg, gif or webp image (or is not an image at all).
class UnsupportedImage implements Exception {
  UnsupportedImage(this.mime);
  final String mime;
  @override
  String toString() => 'UnsupportedImage: $mime';
}

class AttachError implements Exception {
  AttachError(this.what);
  final String what;
  @override
  String toString() => 'AttachError: $what';
}

/// [bytes] as the desktop prepares a pasted image, decoded and re-encoded in an isolate so a 12 MP photo costs the UI
/// thread nothing. Throws [UnsupportedImage] for a type `/attach` does not take or bytes that do not decode.
Future<Prepared> prepareImage(
  Uint8List bytes,
  String mime, {
  @visibleForTesting
  (Uint8List, String)? Function(Uint8List, String) prepare = _prepare,
}) async {
  if (!imageTypes.contains(mime)) throw UnsupportedImage(mime);
  final r = await Isolate.run(() {
    try {
      return prepare(bytes, mime);
    } catch (_) {
      // a truncated or corrupt file: the decoders also fail with a RangeError or a StateError
      return null;
    }
  });
  if (r == null) throw UnsupportedImage(mime);
  return Prepared(r.$1, r.$2);
}

(Uint8List, String)? _prepare(Uint8List bytes, String mime) {
  final decoder = img.findDecoderForData(bytes);
  final info = decoder?.startDecode(bytes);
  if (decoder == null || info == null) return null;
  final long = math.max(info.width, info.height);
  final scale = math.min(1.0, imgEdge / long);
  if (scale == 1 && bytes.length <= imgBytes) return (bytes, mime);
  var im = img.decodeImage(bytes);
  if (im == null) return null;
  im = img.bakeOrientation(
    im,
  ); // the desktop's createImageBitmap applies it too
  final s = math.min(1.0, imgEdge / math.max(im.width, im.height));
  if (s < 1) {
    im = img.copyResize(
      im,
      width: (im.width * s).round(),
      height: (im.height * s).round(),
      interpolation: img.Interpolation.average,
    );
  }
  final png = img.encodePng(im);
  if (png.length <= imgBytes) return (png, 'image/png');
  return (img.encodeJpg(im, quality: 90), 'image/jpeg');
}

/// POST /attach through the window's own request path [http]. [label] is how the message names the image
/// (`imgLabel` of the web's i18n, `[image 1]`).
Future<ImageRef> uploadImageVia(
  WindowHttp http,
  Prepared p,
  String label,
) async {
  final res = await http(
    'POST',
    '/attach',
    headers: {'content-type': p.mime},
    body: p.bytes,
  );
  if (res.status != 200) throw AttachError('/attach ${res.status}');
  final Object? j;
  try {
    j = jsonDecode(utf8.decode(res.body));
  } on FormatException {
    throw AttachError('bad reply');
  }
  if (j is! Map || j['id'] is! String) throw AttachError('bad reply');
  final type = ImageType.fromJson(j['mediaType']);
  if (type == ImageType.$unknown) throw AttachError('bad reply');
  return ImageRef(id: j['id'] as String, mediaType: type, label: label);
}

/// [uploadImageVia] through [tab]'s window; an [AttachError] while its host is offline.
Future<ImageRef> uploadImage(WindowTab tab, Prepared p, String label) async {
  final http = windowHttp(tab);
  if (http == null) throw AttachError('offline');
  return await uploadImageVia(http, p, label);
}
