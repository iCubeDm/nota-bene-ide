// A media comment's files, made and stored as the desktop's prepareMediaComment does (web/src/media/markup/
// createMediaComment.ts): the natural-size frame and layer to `/marks/<comment id>/`, the agent's frame to `/attach`.
import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:nb_channel/nb_channel.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'render.dart';

/// One request to the window (its port is the caller's).
typedef WindowHttp =
    Future<HttpAnswer> Function(
      String method,
      String path, {
      Map<String, String>? headers,
      List<int>? body,
    });

class MarkSaveError implements Exception {
  MarkSaveError(this.what);
  final String what;
  @override
  String toString() => 'MarkSaveError: $what';
}

Future<void> _put(
  WindowHttp http,
  String path,
  String type,
  Uint8List b,
) async {
  final r = await http('POST', path, headers: {'content-type': type}, body: b);
  if (r.status < 200 || r.status > 299) {
    throw MarkSaveError('$path ${r.status}');
  }
}

/// Renders [shapes] on [source] (natural size [w]×[h]), stores the files under [id] (the comment's id) and attaches
/// the agent's frame. Returns the attachment's id (the comment's only generated image) and the scale when the files
/// had to be downscaled. On any failure `/marks/<id>` is deleted and the error rethrown.
Future<({String image, double? scale})> prepareMediaComment(
  WindowHttp http,
  String id,
  ui.Image source,
  int w,
  int h,
  List<MediaShape> shapes,
) async {
  ui.Image? composite;
  try {
    final r = await renderMarks(source, w, h, shapes);
    composite = r.composite;
    await _put(http, '/marks/$id/frame.jpg', 'image/jpeg', r.frame);
    await _put(http, '/marks/$id/layer.png', 'image/png', r.layer);
    final a = await agentImage(r.composite, r.frame);
    final res = await http(
      'POST',
      '/attach',
      headers: {'content-type': a.type},
      body: a.bytes,
    );
    final j = res.status == 200 ? jsonDecode(utf8.decode(res.body)) : null;
    if (j is! Map || j['id'] is! String) {
      throw MarkSaveError('/attach ${res.status}');
    }
    return (image: j['id'] as String, scale: r.scale < 1 ? r.scale : null);
  } catch (_) {
    try {
      // a 409 means the comment is already sent and keeps its files; anything else leaves an orphan, not an error
      await http('DELETE', '/marks/$id');
    } catch (_) {}
    rethrow;
  } finally {
    composite?.dispose();
  }
}
