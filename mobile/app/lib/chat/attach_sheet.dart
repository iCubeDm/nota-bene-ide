import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../media/picker.dart';
import '../ui/nb_icon.dart';

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
            (PickSource.camera, t.attachCamera, NbGlyph.camera),
            (PickSource.gallery, t.attachGallery, NbGlyph.image),
            (PickSource.file, t.attachFile, NbGlyph.file),
          ])
            ListTile(
              leading: NbIcon(glyph, size: 22),
              title: Text(label),
              onTap: () => Navigator.pop(c, s),
            ),
        ],
      ),
    ),
  );
}
