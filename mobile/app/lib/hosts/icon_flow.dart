// Set icon / Remove icon of a session row: the picture comes from the camera or the gallery, is cut to a centre square of
// 256 px on the phone and goes to the host; the window list then names its new version.
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:nb_channel/nb_channel.dart';

import '../chat/attach_sheet.dart';
import '../l10n/app_localizations.dart';
import '../media/attach.dart' show Prepared;
import '../media/media_comment.dart' show WindowHttp;
import '../media/picker.dart';
import 'host_link.dart';
import 'project_icon.dart';

WindowHttp? _httpOf(HostLink link, HostWindow w) {
  final ch = link.channel;
  if (ch == null) return null;
  return (method, path, {headers, body}) =>
      ch.http(w.port, method, path, headers: headers, body: body);
}

/// Asks where the picture comes from, then sets it as the icon of [w]'s project folder. Errors end in a snackbar.
Future<void> setProjectIconFlow(
  BuildContext context,
  HostLink link,
  HostWindow w, {
  @visibleForTesting Future<Prepared> Function(Uint8List) square = squareIcon,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  final failed = AppLocalizations.of(context).iconFailed;
  final source = await showAttachSheet(context);
  if (source == null) return;
  void fail() => messenger.showSnackBar(SnackBar(content: Text(failed)));
  try {
    final picked = await pickImages(source);
    if (picked.images.isEmpty) {
      // over the phone's limit; nothing picked and nothing skipped is a cancel
      if (picked.skipped.isNotEmpty) {
        fail();
      }
      return;
    }
    // one picture: any further ones the system returned are dropped
    for (final extra in picked.images.skip(1)) {
      await extra.delete();
    }
    final first = picked.images.first;
    final Uint8List bytes;
    try {
      bytes = await first.read();
    } finally {
      await first.delete();
    }
    final http = _httpOf(link, w);
    if (http == null) {
      fail();
      return;
    }
    final prepared = await square(bytes);
    await putProjectIcon(http, prepared);
    await link.refresh();
  } on Object {
    fail();
  }
}

/// Removes the icon of [w]'s project folder.
Future<void> removeProjectIconFlow(
  BuildContext context,
  HostLink link,
  HostWindow w,
) async {
  final messenger = ScaffoldMessenger.of(context);
  final failed = AppLocalizations.of(context).iconFailed;
  try {
    final http = _httpOf(link, w);
    if (http == null) throw IconError('offline');
    await deleteProjectIcon(http);
    await link.refresh();
  } on Object {
    messenger.showSnackBar(SnackBar(content: Text(failed)));
  }
}
