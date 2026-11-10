import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/attach_sheet.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/media/gallery.dart';
import 'package:nb_app/media/picker.dart';

class FakeGallery implements GallerySource {
  FakeGallery(this.have, {this.state = GalleryAccess.full});
  final List<GalleryItem> have;
  GalleryAccess state;
  // what a Grant access / manage tap turns the access into
  GalleryAccess? afterAsk;
  final asked = <bool>[];
  final pages = <(int, int)>[];
  Completer<Uint8List?>? thumbHold;
  final taken = <List<GalleryItem>>[];

  @override
  Future<GalleryAccess> access({
    bool ask = false,
    bool settings = false,
  }) async {
    asked.add(ask);
    // the first ask is the sheet's own, when it opens; a later one is the user's tap
    if (ask && asked.where((a) => a).length > 1 && afterAsk != null) {
      state = afterAsk!;
    }
    return state;
  }

  @override
  Future<List<GalleryItem>> page(int offset, int limit) async {
    pages.add((offset, limit));
    return have.skip(offset).take(limit).toList();
  }

  @override
  Future<Uint8List?> thumbnail(GalleryItem item, int px) =>
      thumbHold?.future ?? Future.value(null);

  @override
  Future<({List<PickedImage> images, List<String> skipped})> take(
    List<GalleryItem> items,
  ) async {
    taken.add(items);
    return (images: const <PickedImage>[], skipped: const <String>[]);
  }
}

List<GalleryItem> items(int n) => [
  for (var i = n; i > 0; i--) GalleryItem(id: i, video: i == 2),
];

void main() {
  late FakeGallery g;
  Object? got;
  var closed = false;

  Future<void> open(
    WidgetTester t,
    FakeGallery fake, {
    bool settle = true,
  }) async {
    g = fake;
    gallerySource = fake;
    got = null;
    closed = false;
    await t.pumpWidget(
      NbApp(
        home: Builder(
          builder: (c) => TextButton(
            onPressed: () async {
              got = await showAttachSheet(c);
              closed = true;
            },
            child: const Text('go'),
          ),
        ),
      ),
    );
    await t.tap(find.text('go'));
    settle ? await t.pumpAndSettle() : await t.pump();
  }

  tearDown(() => gallerySource = ChannelGallery());

  Finder cell(int id) => find.byKey(ValueKey('media-$id'));
  Finder badge(int id, String n) =>
      find.descendant(of: cell(id), matching: find.text(n));

  testWidgets('the grid lists the newest first', (t) async {
    await open(t, FakeGallery(items(6)));
    final xs = [for (var id = 6; id > 0; id--) t.getTopLeft(cell(id))];
    // row by row, left to right: 6 is first
    for (var i = 1; i < xs.length; i++) {
      final a = xs[i - 1], b = xs[i];
      expect(
        a.dy < b.dy || (a.dy == b.dy && a.dx < b.dx),
        isTrue,
        reason: '$i',
      );
    }
    expect(g.pages.first.$1, 0);
  });

  testWidgets('a video shows its length', (t) async {
    final v = [
      const GalleryItem(id: 1, video: true, duration: Duration(seconds: 75)),
    ];
    await open(t, FakeGallery(v));
    expect(
      find.descendant(of: cell(1), matching: find.text('1:15')),
      findsOneWidget,
    );
  });

  testWidgets('taps number the choice and a deselect renumbers', (t) async {
    await open(t, FakeGallery(items(6)));
    await t.tap(cell(5));
    await t.tap(cell(3));
    await t.tap(cell(6));
    await t.pump();
    expect(badge(5, '1'), findsOneWidget);
    expect(badge(3, '2'), findsOneWidget);
    expect(badge(6, '3'), findsOneWidget);
    await t.tap(cell(5));
    await t.pump();
    expect(badge(3, '1'), findsOneWidget);
    expect(badge(6, '2'), findsOneWidget);
    expect(find.text('3'), findsNothing);
  });

  testWidgets('Send hands the chosen items, in the order of choice, back', (
    t,
  ) async {
    await open(t, FakeGallery(items(6)));
    expect(find.text('Send'), findsNothing);
    await t.tap(cell(4));
    await t.tap(cell(2));
    await t.pump();
    await t.tap(find.text('Send'));
    await t.pumpAndSettle();
    final c = got as AttachItems;
    expect([for (final i in c.items) i.id], [4, 2]);
    expect(c.items[1].video, isTrue);
  });

  testWidgets('Gallery, File and Camera still answer their source', (t) async {
    for (final (label, source) in [
      ('Gallery', PickSource.gallery),
      ('File', PickSource.file),
      ('Camera', PickSource.camera),
    ]) {
      await open(t, FakeGallery(items(3)));
      await t.tap(find.text(label));
      await t.pumpAndSettle();
      expect((got as AttachFrom).source, source);
    }
  });

  testWidgets('the sheet is there before the list and the thumbnails', (
    t,
  ) async {
    final hold = Completer<Uint8List?>();
    final f = FakeGallery(items(3))..thumbHold = hold;
    await open(t, f, settle: false);
    expect(find.text('Camera'), findsOneWidget);
    await t.pump();
    // the cells are there while their thumbnails are still on their way
    expect(cell(3), findsOneWidget);
    expect(closed, isFalse);
  });

  testWidgets('it pages: the next page loads at the end of the grid', (
    t,
  ) async {
    await open(t, FakeGallery(items(100)));
    expect(g.pages.length, 1);
    await t.drag(find.byType(GridView), const Offset(0, -5000));
    await t.pumpAndSettle();
    expect(g.pages.length, greaterThan(1));
    expect(g.pages[1].$1, g.pages[0].$2);
  });

  testWidgets('denied: a line with Grant access instead of the grid', (
    t,
  ) async {
    await open(t, FakeGallery(items(3), state: GalleryAccess.denied));
    expect(
      find.text('Allow access to photos to see the latest ones here.'),
      findsOneWidget,
    );
    expect(cell(3), findsNothing);
    expect(g.asked, [true]); // asked when the sheet opened
    expect(find.text('Camera'), findsOneWidget);
    expect(find.text('Gallery'), findsOneWidget);
    expect(find.text('File'), findsOneWidget);
  });

  testWidgets('Grant access asks again and shows the grid when it is given', (
    t,
  ) async {
    final f = FakeGallery(items(3), state: GalleryAccess.denied)
      ..afterAsk = GalleryAccess.full;
    await open(t, f);
    await t.tap(find.text('Grant access'));
    await t.pumpAndSettle();
    expect(cell(3), findsOneWidget);
    expect(find.text('Grant access'), findsNothing);
  });

  testWidgets('partial access shows the allowed items and a manage link', (
    t,
  ) async {
    final f = FakeGallery(items(3), state: GalleryAccess.partial)
      ..afterAsk = GalleryAccess.full;
    await open(t, f);
    expect(cell(3), findsOneWidget);
    expect(find.text('Only the photos you allowed are shown.'), findsOneWidget);
    await t.tap(find.text('Manage'));
    await t.pumpAndSettle();
    expect(f.asked.last, isTrue);
    expect(find.text('Manage'), findsNothing);
  });

  testWidgets('an empty gallery says so', (t) async {
    await open(t, FakeGallery(const []));
    expect(find.text('No photos or videos yet.'), findsOneWidget);
  });
}
