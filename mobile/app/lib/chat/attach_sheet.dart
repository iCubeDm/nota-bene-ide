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
  final _seen = <int>{};
  final _chosen = <GalleryItem>[];
  // null while the system is still being asked: the sheet is already open, the rest of it fills in
  GalleryAccess? _access;
  bool _loading = false, _end = false, _loaded = false, _failed = false;
  bool _capped = false;
  // The list's generation: a new one starts when the access or the choice of photos changes. A load of an older one is
  // dropped when it arrives and does not keep a load of the current one from starting.
  int _epoch = 0;
  int _loadEpoch = -1;
  // the latest access question; an older answer is of no use
  int _asking = 0;
  // the user went to the system settings or to the selection of photos: the access is looked at again on the way back
  bool _away = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _scroll.addListener(_nearEnd);
    _open();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _scroll.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _away) {
      _away = false;
      _check();
    }
  }

  // Looks at the access, and asks only when there is none: a partial one is changed by Manage alone.
  Future<void> _open() async {
    await _check();
    if (mounted && _access == GalleryAccess.denied) await _check(ask: true);
  }

  Future<void> _check({bool ask = false, bool settings = false}) async {
    final asking = ++_asking;
    final a = await gallerySource.access(ask: ask, settings: settings);
    if (!mounted || asking != _asking) return;
    // an explicit ask may have changed what is allowed without changing the kind of access
    final fresh =
        a != _access || !_loaded || (ask && a != GalleryAccess.denied);
    setState(() => _access = a);
    if (a == GalleryAccess.denied) {
      _reset();
    } else if (fresh) {
      _reset();
      await _more();
    }
  }

  void _reset() => setState(() {
    _epoch++;
    _items.clear();
    _seen.clear();
    _chosen.clear();
    _end = _loaded = _failed = _capped = false;
  });

  Future<void> _more() async {
    final epoch = _epoch;
    if (_end || (_loading && _loadEpoch == epoch)) return;
    _loading = true;
    _loadEpoch = epoch;
    try {
      final got = await gallerySource.page(
        _items.isEmpty ? null : _items.last,
        _pageSize,
      );
      if (!mounted || epoch != _epoch) return;
      setState(() {
        // a photo taken meanwhile moves what the next page starts at: what is on the screen already is not added again
        _items.addAll(got.where((i) => _seen.add(i.id)));
        _end = got.length < _pageSize;
        _loaded = true;
        _failed = false;
      });
    } on PlatformException {
      if (mounted && epoch == _epoch) {
        setState(() => _failed = _loaded = true);
      }
    } finally {
      if (_loadEpoch == epoch) _loading = false;
    }
  }

  void _nearEnd() {
    if (_scroll.position.extentAfter < 800) _more();
  }

  void _toggle(GalleryItem i) {
    if (!_chosen.contains(i) && _chosen.length >= maxAttachCount) {
      setState(() => _capped = true);
      return;
    }
    setState(() {
      _capped = false;
      _chosen.contains(i) ? _chosen.remove(i) : _chosen.add(i);
    });
  }

  static int _bucket(double px) =>
      px <= 128 ? 128 : (px <= 256 ? 256 : (px <= 384 ? 384 : 512));

  Widget _grid(int px) => GridView.builder(
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
        px: px,
        number: _chosen.indexOf(item) + 1,
        onTap: () => _toggle(item),
      );
    },
  );

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
                      onPressed: () {
                        _away = true;
                        _check(ask: true, settings: a == GalleryAccess.denied);
                      },
                      child: Text(
                        a == GalleryAccess.denied
                            ? t.attachGrant
                            : t.attachManage,
                      ),
                    ),
                  ],
                ),
              ),
            if (_failed)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
                child: Text(
                  t.attachLoadFailed,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            Expanded(
              child: switch (a) {
                null || GalleryAccess.denied => const SizedBox.shrink(),
                _ when _loaded && _items.isEmpty && !_failed => Center(
                  child: Text(t.attachNoMedia),
                ),
                _ => LayoutBuilder(
                  builder: (c, box) => _grid(
                    // the thumbnail is as big as its cell is on the screen, in steps so that a resize asks for few sizes
                    _bucket(
                      box.maxWidth /
                          _columns *
                          MediaQuery.devicePixelRatioOf(c),
                    ),
                  ),
                ),
              },
            ),
            if (_capped)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
                child: Text(
                  t.attachMax(maxAttachCount),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
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
    required this.px,
    required this.number,
    required this.onTap,
  });
  final GalleryItem item;
  final int px;
  final int number;
  final VoidCallback onTap;

  @override
  State<_Cell> createState() => _CellState();
}

class _CellState extends State<_Cell> {
  bool _done = false;
  late final Future<Uint8List?> _thumb = gallerySource
      .thumbnail(widget.item, widget.px)
      .then<Uint8List?>((b) => b, onError: (Object _) => null)
      .whenComplete(() => _done = true);

  @override
  void initState() {
    super.initState();
    _thumb; // asked for now, not when it is first drawn
  }

  // scrolled away or the sheet closed before the thumbnail came: nobody waits for it
  @override
  void dispose() {
    if (!_done) gallerySource.cancel(widget.item, widget.px);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final chosen = widget.number > 0;
    final t = AppLocalizations.of(context);
    return Semantics(
      button: true,
      selected: chosen,
      label: chosen ? t.attachPhotoSelected(widget.number) : t.attachPhoto,
      excludeSemantics: true,
      onTap: widget.onTap,
      child: GestureDetector(
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
      ),
    );
  }
}
