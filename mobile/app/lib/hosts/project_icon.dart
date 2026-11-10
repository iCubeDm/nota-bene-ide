// The picture of a project folder (protocol 15): stored on the host beside Nota Bene's state, shared by every window of the
// folder, set and removed from this phone. The window list names its version (a hash); the bytes are fetched once per
// version and kept in memory.
import 'dart:async';
import 'dart:convert';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image/image.dart' as img;

import '../media/attach.dart' show Prepared, UnsupportedImage;
import '../media/media_comment.dart' show WindowHttp;
import 'host_link.dart';

/// The edge of the stored picture; the host takes up to [iconMaxBytes].
const iconEdge = 256;
const iconMaxBytes = 256 * 1024;

class IconError implements Exception {
  IconError(this.what);
  final String what;
  @override
  String toString() => 'IconError: $what';
}

/// [bytes] as the stored icon: a centre square crop of the image, [iconEdge] pixels a side, a PNG (a JPEG when the PNG
/// would pass [iconMaxBytes]). Decoded in an isolate. Throws [UnsupportedImage] for bytes that do not decode.
Future<Prepared> squareIcon(Uint8List bytes) async {
  final r = await Isolate.run(() {
    try {
      return _square(bytes);
    } catch (_) {
      return null; // a truncated file: the decoders also fail with a RangeError or a StateError
    }
  });
  if (r == null) throw UnsupportedImage('image/*');
  return Prepared(r.$1, r.$2);
}

(Uint8List, String)? _square(Uint8List bytes) {
  var im = img.decodeImage(bytes);
  if (im == null) return null;
  im = img.bakeOrientation(im);
  final side = math.min(im.width, im.height);
  im = img.copyCrop(
    im,
    x: (im.width - side) ~/ 2,
    y: (im.height - side) ~/ 2,
    width: side,
    height: side,
  );
  if (side != iconEdge) {
    im = img.copyResize(
      im,
      width: iconEdge,
      height: iconEdge,
      interpolation: img.Interpolation.average,
    );
  }
  final png = img.encodePng(im);
  if (png.length <= iconMaxBytes) return (png, 'image/png');
  return (img.encodeJpg(im, quality: 85), 'image/jpeg');
}

/// PUT /project-icon; the version the host answered.
Future<String> putProjectIcon(WindowHttp http, Prepared p) async {
  final res = await http(
    'PUT',
    '/project-icon',
    headers: {'content-type': p.mime},
    body: p.bytes,
  );
  if (res.status != 200) throw IconError('/project-icon ${res.status}');
  try {
    if (jsonDecode(utf8.decode(res.body)) case {'icon': final String v}) {
      return v;
    }
  } on FormatException {
    // falls through
  }
  throw IconError('bad reply');
}

Future<void> deleteProjectIcon(WindowHttp http) async {
  final res = await http('DELETE', '/project-icon');
  if (res.status != 204 && res.status != 200) {
    throw IconError('/project-icon ${res.status}');
  }
}

/// The pictures fetched so far, by version (a version is the hash of the bytes, so it is the same picture on any host).
class ProjectIcons {
  ProjectIcons({this.capacity = 48});

  static final instance = ProjectIcons();

  final int capacity;
  final _bytes =
      <String, Uint8List>{}; // insertion order: the oldest goes first
  final _pending = <String, Future<Uint8List?>>{};

  Uint8List? cached(String version) => _bytes[version];

  /// The picture of [version] through [http] (null while the host is offline); null when the host has none by now.
  Future<Uint8List?> load(String version, WindowHttp? http) {
    final have = _bytes[version];
    if (have != null) return Future.value(have);
    if (http == null) return Future.value(null);
    return _pending[version] ??= _fetch(version, http).whenComplete(() {
      _pending.remove(
        version,
      ); // a block: a returned future would be awaited, and this one is its own
    });
  }

  Future<Uint8List?> _fetch(String version, WindowHttp http) async {
    try {
      final res = await http('GET', '/project-icon');
      if (res.status != 200 || res.body.isEmpty) return null;
      _bytes[version] = res.body;
      while (_bytes.length > capacity) {
        _bytes.remove(_bytes.keys.first);
      }
      return res.body;
    } on Object {
      return null; // offline or a broken stream: the letter stays
    }
  }
}

/// A round avatar: the folder's picture when the window lists one and it has arrived, else [fallback] (the letter).
class ProjectIconAvatar extends StatefulWidget {
  const ProjectIconAvatar({
    super.key,
    required this.link,
    required this.port,
    required this.icon,
    required this.size,
    required this.fallback,
    this.icons,
  });

  final HostLink link;
  final int port;

  /// The version the window list names; null: no picture.
  final String? icon;
  final double size;
  final Widget fallback;
  final ProjectIcons? icons;

  @override
  State<ProjectIconAvatar> createState() => _ProjectIconAvatarState();
}

class _ProjectIconAvatarState extends State<ProjectIconAvatar> {
  Uint8List? _bytes;
  bool _loading = false;

  ProjectIcons get _icons => widget.icons ?? ProjectIcons.instance;

  @override
  void initState() {
    super.initState();
    widget.link.addListener(_linkChanged);
    _load();
  }

  @override
  void didUpdateWidget(ProjectIconAvatar old) {
    super.didUpdateWidget(old);
    if (old.link != widget.link) {
      old.link.removeListener(_linkChanged);
      widget.link.addListener(_linkChanged);
    }
    if (old.icon != widget.icon) {
      _bytes = null;
      _load();
    }
  }

  @override
  void dispose() {
    widget.link.removeListener(_linkChanged);
    super.dispose();
  }

  // an avatar that could not fetch (the host was offline) tries again when the link is up
  void _linkChanged() {
    if (_bytes == null && !_loading) _load();
  }

  WindowHttp? get _http {
    final ch = widget.link.channel;
    if (ch == null) return null;
    final port = widget.port;
    return (method, path, {headers, body}) =>
        ch.http(port, method, path, headers: headers, body: body);
  }

  void _load() {
    final v = widget.icon;
    if (v == null) return;
    final have = _icons.cached(v);
    if (have != null) {
      _bytes = have;
      return;
    }
    _loading = true;
    _icons.load(v, _http).then((b) {
      _loading = false;
      if (!mounted || widget.icon != v) return;
      if (b != null) setState(() => _bytes = b);
    });
  }

  @override
  Widget build(BuildContext context) {
    final b = widget.icon == null ? null : _bytes;
    if (b == null) return widget.fallback;
    final px = (widget.size * MediaQuery.devicePixelRatioOf(context)).round();
    return ClipOval(
      child: Image.memory(
        b,
        key: const ValueKey('project-icon'),
        width: widget.size,
        height: widget.size,
        fit: BoxFit.cover,
        cacheWidth: px,
        gaplessPlayback: true,
        errorBuilder: (_, _, _) => widget.fallback,
      ),
    );
  }
}
