// The project pictures the app has fetched (issue 565: a store, apart from the avatar and the image work in
// hosts/project_icon.dart).
import 'dart:typed_data';

import 'package:nb_channel/nb_channel.dart' show WindowHttp;

/// The pictures fetched so far, by version (a version is the hash of the bytes, so it is the same picture on any host).
class ProjectIcons {
  ProjectIcons({this.capacity = 48});

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
      // kept only when the host says these are the bytes of the version asked for: the picture may have changed
      // between the list and the fetch, and the next list names the new version
      final etag = res.headers.entries
          .where((e) => e.key.toLowerCase() == 'etag')
          .map((e) => e.value.replaceAll('"', ''))
          .firstOrNull;
      if (etag == version) {
        _bytes[version] = res.body;
        while (_bytes.length > capacity) {
          _bytes.remove(_bytes.keys.first);
        }
      }
      return res.body;
    } on Object {
      return null; // offline or a broken stream: the letter stays
    }
  }
}
