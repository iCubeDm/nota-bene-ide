import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/attach_sheet.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/media/attach.dart' show imageTypes;
import 'package:nb_app/media/gallery.dart';
import 'package:nb_app/media/picker.dart';

class FakeGallery implements GallerySource {
  FakeGallery(this.have, {this.state = GalleryAccess.full});
  List<GalleryItem> have;
  GalleryAccess state;
  // what a Grant access / Manage tap turns the access into, and what else happens then
  GalleryAccess? afterAsk;
  void Function()? onAsk;
  final asked = <bool>[];
  final pages = <(int?, int)>[];
  // while set, access / page / thumbnail replies are held back
  Completer<void>? accessHold, pageHold;
  Completer<Uint8List?>? thumbHold;
  bool failPage = false;
  // a page starts this many items before its cursor: the library changed between two pages
  int overlap = 0;
  final cancelled = <int>[];
  final taken = <List<GalleryItem>>[];

  @override
  Future<GalleryAccess> access({
    bool ask = false,
    bool settings = false,
  }) async {
    asked.add(ask);
    // the sheet asks of its own only when there is no access; any other ask is the user's tap
    if (ask &&
        (state != GalleryAccess.denied || asked.where((a) => a).length > 1)) {
      if (afterAsk != null) state = afterAsk!;
      onAsk?.call();
    }
    await accessHold?.future;
    return state;
  }

  @override
  Future<List<GalleryItem>> page(GalleryItem? after, int limit) async {
    pages.add((after?.id, limit));
    await pageHold?.future;
    if (failPage) throw PlatformException(code: 'read');
    final from = after == null
        ? 0
        : have.indexWhere((i) => i.id == after.id) + 1 - overlap;
    return have.skip(from.clamp(0, have.length)).take(limit).toList();
  }

  @override
  Future<Uint8List?> thumbnail(GalleryItem item, int px) =>
      thumbHold?.future ?? Future.value(null);

  @override
  void cancel(GalleryItem item, int px) => cancelled.add(item.id);

  @override
  Future<Picked> take(List<GalleryItem> items) async {
    taken.add(items);
    return (
      images: const <PickedImage>[],
      skipped: const <String>[],
      unreadable: const <String>[],
    );
  }
}

List<GalleryItem> items(int n) => [
  for (var i = n; i > 0; i--) GalleryItem(id: i, added: i),
];

void main() {
  late FakeGallery g;
  late FakeGallery fake;
  void setHave(List<GalleryItem> l) => fake.have = l;
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
    expect(g.pages.first.$1, isNull);
  });

  testWidgets('only the types the attach flow takes are asked for', (t) async {
    Object? args;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(galleryChannel, (call) async {
          args = call.arguments;
          return [
            {'id': 7},
          ];
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(galleryChannel, null),
    );
    final got = await ChannelGallery().page(null, 60);
    expect([for (final i in got) i.id], [7]);
    // the phone filters by these: no heic, no video, nothing selectable that fails later
    expect((args as Map)['mimes'], imageTypes);
    expect(imageTypes, isNot(contains('image/heic')));
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
    expect(
      g.pages[1].$1,
      41,
    ); // the cursor is the last item of the first page (ids 100..41)
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
    expect(g.asked, [false, true]); // asked when the sheet opened
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
    expect(
      f.asked.where((a) => a),
      hasLength(1),
    ); // opening a partial sheet did not ask
    expect(find.text('Manage'), findsNothing);
  });

  testWidgets('an empty gallery says so', (t) async {
    await open(t, FakeGallery(const []));
    expect(find.text('No photos yet.'), findsOneWidget);
  });

  testWidgets(
    'a permission reply, then resume with the page pending: the grid fills',
    (t) async {
      final f = FakeGallery(items(3))..pageHold = Completer<void>();
      await open(t, f, settle: false);
      await t.pump();
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await t.pump();
      f.pageHold!.complete();
      await t.pumpAndSettle();
      expect(cell(3), findsOneWidget);
      expect(find.text('No photos yet.'), findsNothing);
    },
  );

  testWidgets('back from the settings page with the first page pending', (
    t,
  ) async {
    final f = FakeGallery(items(3), state: GalleryAccess.denied)
      ..afterAsk = GalleryAccess.full;
    await open(t, f);
    f.pageHold = Completer<void>();
    await t.tap(find.text('Grant access'));
    await t.pump();
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await t.pump();
    f.pageHold!.complete();
    await t.pumpAndSettle();
    expect(cell(3), findsOneWidget);
  });

  testWidgets('Manage reloads the list even when the access stays partial', (
    t,
  ) async {
    final f = FakeGallery(items(6), state: GalleryAccess.partial)
      ..onAsk = () => setHave(const [
        GalleryItem(id: 50, added: 50),
        GalleryItem(id: 49, added: 49),
      ]);
    fake = f;
    await open(t, f);
    expect(cell(6), findsOneWidget);
    await t.tap(find.text('Manage'));
    await t.pumpAndSettle();
    expect(cell(50), findsOneWidget);
    expect(cell(6), findsNothing);
  });

  testWidgets('a page that repeats items does not repeat their cells', (
    t,
  ) async {
    final f = FakeGallery(items(100))..overlap = 6;
    await open(t, f);
    await t.drag(find.byType(GridView), const Offset(0, -5000));
    await t.pumpAndSettle();
    await t.drag(find.byType(GridView), const Offset(0, -5000));
    await t.pumpAndSettle();
    expect(f.pages.length, greaterThan(1));
    final delegate = t.widget<GridView>(find.byType(GridView)).childrenDelegate;
    expect(delegate.estimatedChildCount, 100);
  });

  testWidgets('no more than ten photos are chosen, with a hint', (t) async {
    t.view.physicalSize = const Size(1200, 3000);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await open(t, FakeGallery(items(14)));
    for (var id = 14; id > 2; id--) {
      await t.tap(cell(id));
    }
    await t.pump();
    expect(badge(5, '10'), findsOneWidget);
    expect(find.text('11'), findsNothing);
    expect(
      find.text('You can attach up to 10 photos at a time.'),
      findsOneWidget,
    );
    await t.tap(find.text('Send'));
    await t.pumpAndSettle();
    expect((got as AttachItems).items, hasLength(10));
  });

  testWidgets('a cell for a photo says so and tells when it is chosen', (
    t,
  ) async {
    final h = t.ensureSemantics();
    await open(t, FakeGallery(items(4)));
    expect(t.getSemantics(cell(4)).label, 'Photo');
    await t.tap(cell(4));
    await t.pump();
    expect(t.getSemantics(cell(4)).label, 'Selected, 1');
    h.dispose();
  });

  testWidgets('leaving the sheet cancels the thumbnails still on their way', (
    t,
  ) async {
    final f = FakeGallery(items(3))..thumbHold = Completer<Uint8List?>();
    await open(t, f);
    await t.tap(find.text('File'));
    await t.pumpAndSettle();
    expect(f.cancelled.toSet(), {1, 2, 3});
  });

  testWidgets('a page that cannot be read is told, not shown as empty', (
    t,
  ) async {
    await open(t, FakeGallery(items(3))..failPage = true);
    expect(find.text('The photos could not be loaded.'), findsOneWidget);
    expect(find.text('No photos yet.'), findsNothing);
  });
}
