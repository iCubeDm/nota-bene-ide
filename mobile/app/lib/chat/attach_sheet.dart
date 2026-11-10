import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show PlatformException, Uint8List;

import '../l10n/app_localizations.dart';
import '../media/gallery.dart';
import '../media/picker.dart';
import '../ui/nb_icon.dart';

/// What the attach sheet answered: a system picker to start, or items of the gallery grid to attach.
sealed class AttachChoice {
  const AttachChoice();
}

class AttachFrom extends AttachChoice {
  const AttachFrom(this.source);
  final PickSource source;
}

class AttachItems extends AttachChoice {
  const AttachItems(this.items);
  final List<GalleryItem> items;
}

/// The latest photos with Gallery, File and Camera above them, as in Telegram; null when dismissed.
Future<AttachChoice?> showAttachSheet(BuildContext context) =>
    showModalBottomSheet<AttachChoice>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (c) => const _AttachSheet(),
    );

const _pageSize =
    60; // a few screens of cells: the next page is loaded before the end is reached
const _columns = 3;

class _AttachSheet extends StatefulWidget {
  const _AttachSheet();

  @override
  State<_AttachSheet> createState() => _AttachSheetState();
}

class _AttachSheetState extends State<_AttachSheet>
    with WidgetsBindingObserver {
  final _scroll = ScrollController();
  final _items = <GalleryItem>[];
  final _chosen = <GalleryItem>[];
  // null while the system is still being asked: the sheet is already open, the rest of it fills in
  GalleryAccess? _access;
  bool _loading = false, _end = false, _loaded = false;
  // a reply for an access that has changed since is of no use
  int _round = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _scroll.addListener(_nearEnd);
    _check(ask: true);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _scroll.dispose();
    super.dispose();
  }

  // back from the system settings, where access may have been given
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _access != null) _check();
  }

  Future<void> _check({bool ask = false, bool settings = false}) async {
    final round = ++_round;
    final a = await gallerySource.access(ask: ask, settings: settings);
    if (!mounted || round != _round) return;
    final changed = a != _access;
    setState(() => _access = a);
    if (a == GalleryAccess.denied) {
      _items.clear();
      _chosen.clear();
      _end = _loaded = false;
    } else if (changed || !_loaded) {
      // another set of items: the list starts again
      _items.clear();
      _chosen.clear();
      _end = _loaded = false;
      await _more();
    }
  }

  Future<void> _more() async {
    if (_loading || _end) return;
    _loading = true;
    final round = _round;
    try {
      final got = await gallerySource.page(_items.length, _pageSize);
      if (!mounted || round != _round) return;
      setState(() {
        _items.addAll(got);
        _end = got.length < _pageSize;
        _loaded = true;
      });
    } on PlatformException {
      if (mounted) setState(() => _end = _loaded = true);
    } finally {
      _loading = false;
    }
  }

  void _nearEnd() {
    final p = _scroll.position;
    if (p.extentAfter < 800) _more();
  }

  void _toggle(GalleryItem i) => setState(() {
    _chosen.contains(i) ? _chosen.remove(i) : _chosen.add(i);
  });

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final a = _access;
    final line = switch (a) {
      GalleryAccess.denied => t.attachGrantLine,
      GalleryAccess.partial => t.attachPartialLine,
      _ => null,
    };
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.7,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Row(
                children: [
                  for (final (s, label, glyph) in [
                    (PickSource.gallery, t.attachGallery, NbGlyph.image),
                    (PickSource.file, t.attachFile, NbGlyph.file),
                    (PickSource.camera, t.attachCamera, NbGlyph.camera),
                  ])
                    Expanded(
                      child: InkWell(
                        borderRadius: BorderRadius.circular(12),
                        onTap: () => Navigator.pop(context, AttachFrom(s)),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 10),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              NbIcon(glyph, size: 24),
                              const SizedBox(height: 4),
                              Text(
                                label,
                                style: Theme.of(context).textTheme.labelMedium,
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
            if (line != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 8, 4),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        line,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ),
                    TextButton(
                      onPressed: () => _check(
                        ask: true,
                        settings: a == GalleryAccess.denied,
                      ),
                      child: Text(
                        a == GalleryAccess.denied
                            ? t.attachGrant
                            : t.attachManage,
                      ),
                    ),
                  ],
                ),
              ),
            Expanded(
              child: switch (a) {
                null || GalleryAccess.denied => const SizedBox.shrink(),
                _ when _loaded && _items.isEmpty => Center(
                  child: Text(t.attachNoMedia),
                ),
                _ => GridView.builder(
                  controller: _scroll,
                  padding: const EdgeInsets.all(2),
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: _columns,
                    mainAxisSpacing: 2,
                    crossAxisSpacing: 2,
                  ),
                  itemCount: _items.length,
                  itemBuilder: (c, i) {
                    final item = _items[i];
                    return _Cell(
                      key: ValueKey('media-${item.id}'),
                      item: item,
                      number: _chosen.indexOf(item) + 1,
                      onTap: () => _toggle(item),
                    );
                  },
                ),
              },
            ),
            if (_chosen.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                child: SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: () =>
                        Navigator.pop(context, AttachItems([..._chosen])),
                    child: Text(t.send),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// One cell: the thumbnail (asked for only when the cell is built, so only what is on the screen), the selection's badge, [number] being the place in the choice (0 when not chosen).
class _Cell extends StatefulWidget {
  const _Cell({
    super.key,
    required this.item,
    required this.number,
    required this.onTap,
  });
  final GalleryItem item;
  final int number;
  final VoidCallback onTap;

  @override
  State<_Cell> createState() => _CellState();
}

class _CellState extends State<_Cell> {
  late final Future<Uint8List?> _thumb = gallerySource
      .thumbnail(widget.item, 256)
      .then<Uint8List?>((b) => b, onError: (Object _) => null);

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final chosen = widget.number > 0;
    return GestureDetector(
      onTap: widget.onTap,
      child: Stack(
        fit: StackFit.expand,
        children: [
          ColoredBox(color: cs.surfaceContainerHighest),
          FutureBuilder<Uint8List?>(
            future: _thumb,
            builder: (c, s) => s.data == null
                ? const SizedBox.shrink()
                : Image.memory(
                    s.data!,
                    fit: BoxFit.cover,
                    gaplessPlayback: true,
                    errorBuilder: (_, _, _) => const SizedBox.shrink(),
                  ),
          ),
          if (chosen) ColoredBox(color: cs.primary.withValues(alpha: 0.25)),
          Positioned(
            top: 6,
            right: 6,
            child: Container(
              width: 22,
              height: 22,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: chosen ? cs.primary : Colors.black26,
                border: Border.all(color: Colors.white, width: 1.5),
              ),
              child: chosen
                  ? Text(
                      '${widget.number}',
                      style: TextStyle(
                        color: cs.onPrimary,
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    )
                  : null,
            ),
          ),
        ],
      ),
    );
  }
}
