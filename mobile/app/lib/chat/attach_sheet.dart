import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../media/picker.dart';

/// Where the image comes from: the camera app, the photo picker or the document picker; null when dismissed.
Future<PickSource?> showAttachSheet(BuildContext context) {
  final t = AppLocalizations.of(context);
  return showModalBottomSheet<PickSource>(
    context: context,
    showDragHandle: true,
    builder: (c) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final (s, label, glyph) in [
            (PickSource.camera, t.attachCamera, Icons.photo_camera_outlined),
            (PickSource.gallery, t.attachGallery, Icons.photo_library_outlined),
            (PickSource.file, t.attachFile, Icons.folder_open_outlined),
          ])
            ListTile(
              leading: Icon(glyph),
              title: Text(label),
              onTap: () => Navigator.pop(c, s),
            ),
        ],
      ),
    ),
  );
}
