import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/comments/comment_sheet.dart';
import 'package:nb_app/media/attach.dart';
import 'package:nb_app/media/picker.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'comments_test.dart' show c;
import 'support/rig.dart';

// The comment sheet's bottom row (attach, delete) and the images a comment carries.
void main() {
  late Rig r;
  SheetResult? got;
  var n = 0;
  final files = <String, Uint8List>{};

  setUp(() {
    r = Rig();
    n = 0;
    files.clear();
    readPickedFile = (path) async => files[path]!;
    deletePickedFile = (path) async {};
    prepareFor = (bytes, mime) async => Prepared(bytes, mime);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pickChannel, (call) async {
          files['/cache/pick/a.png'] = Uint8List.fromList([1, 2, 3]);
          files['/cache/pick/b.png'] = Uint8List.fromList([4, 5, 6]);
          return [
            for (final f in ['a.png', 'b.png'])
              {'path': '/cache/pick/$f', 'mime': 'image/png', 'name': f},
          ];
        });
  });
  tearDown(() {
    prepareFor = prepareImage;
    readPickedFile = defaultReadPickedFile;
    deletePickedFile = defaultDeletePickedFile;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pickChannel, null);
    r.dispose();
  });

  String idOf(int i) => i.toRadixString(16).padLeft(64, '0');

  Future<void> openSheet(WidgetTester t, {Comment? editing}) async {
    t.view.physicalSize = const Size(400, 800);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await r.open(t);
    r.ch.onHttp = (port, method, path) async {
      if (path == '/attach') {
        return (
          status: 200,
          headers: const <String, String>{},
          body: Uint8List.fromList(
            utf8.encode(
              jsonEncode({'id': idOf(n++), 'mediaType': 'image/png'}),
            ),
          ),
        );
      }
      return (
        status: 404,
        headers: const <String, String>{},
        body: Uint8List(0),
      );
    };
    got = null;
    showCommentSheet(
      t.element(find.byType(Scaffold).first),
      quote: 'q',
      editing: editing,
      tab: r.tab,
    ).then((v) => got = v);
    await t.pumpAndSettle();
  }

  final thumbs = find.byKey(const ValueKey('comment-image'));
  final attachButton = find.byKey(const ValueKey('comment-attach'));

  Future<void> attach(WidgetTester t) async {
    await t.tap(attachButton);
    await t.pumpAndSettle();
    await t.tap(find.text('Gallery'));
    await t.pumpAndSettle();
  }

  Future<void> send(WidgetTester t) async {
    await t.tap(find.byKey(const ValueKey('send')));
    await t.pumpAndSettle();
  }

  group('bottom insets', () {
    testWidgets('the bottom row stays above the navigation bar', (t) async {
      t.view.padding = const FakeViewPadding(bottom: 48);
      t.view.viewPadding = const FakeViewPadding(bottom: 48);
      addTearDown(t.view.resetPadding);
      addTearDown(t.view.resetViewPadding);
      await openSheet(t, editing: c('x', 'q', 'text'));
      final del = find.byTooltip('Delete comment');
      expect(del, findsOneWidget);
      expect(t.getRect(del).bottom, lessThanOrEqualTo(800 - 48));
      expect(t.getRect(attachButton).bottom, lessThanOrEqualTo(800 - 48));
    });
  });

  group('delete', () {
    testWidgets('is a trash icon button with a tooltip, not a text button', (
      t,
    ) async {
      await openSheet(t, editing: c('x', 'q', 'text'));
      expect(find.widgetWithText(TextButton, 'Delete comment'), findsNothing);
      expect(
        find.descendant(
          of: find.byType(BottomSheet),
          matching: find.byWidgetPredicate(
            (w) => w is IconButton && w.tooltip == 'Delete comment',
          ),
        ),
        findsOneWidget,
      );
      await t.tap(find.byTooltip('Delete comment'));
      await t.pumpAndSettle();
      expect(got, isA<SheetDelete>());
    });
  });

  group('images', () {
    testWidgets('attached images show thumbnails and Send carries their ids', (
      t,
    ) async {
      await openSheet(t);
      await attach(t);
      expect(thumbs, findsNWidgets(2));
      await send(t);
      expect((got as SheetSave).images, [idOf(0), idOf(1)]);
    });

    testWidgets('an image can be removed before Send', (t) async {
      await openSheet(t);
      await attach(t);
      await t.tap(find.byTooltip('Remove').first);
      await t.pumpAndSettle();
      expect(thumbs, findsOneWidget);
      await send(t);
      expect((got as SheetSave).images, [idOf(1)]);
    });

    testWidgets('images alone make the comment sendable', (t) async {
      await openSheet(t);
      await attach(t);
      expect(
        t.widget<IconButton>(find.byKey(const ValueKey('send'))).onPressed,
        isNotNull,
      );
    });

    testWidgets('an edit starts with the images the comment has', (t) async {
      final x = Comment(
        id: 'x',
        anchor: c('x', 'q', 't').anchor,
        text: 't',
        status: CommentStatus.pending,
        createdAt: 1,
        images: [idOf(7)],
      );
      await openSheet(t, editing: x);
      expect(thumbs, findsOneWidget);
      await send(t);
      expect((got as SheetSave).images, [idOf(7)]);
    });

    testWidgets('closing after attaching asks about the draft', (t) async {
      await openSheet(t);
      await attach(t);
      await t.binding.handlePopRoute();
      await t.pumpAndSettle();
      expect(find.text('Discard the comment?'), findsOneWidget);
    });

    testWidgets(
      'the saved comment carries the ids; an edit keeps a media frame',
      (t) async {
        await openSheet(t);
        await attach(t);
        await send(t);
        final res = got as SheetSave;
        final x = r.tab!.comments.add(
          c('x', 'q', 't').anchor,
          res.text,
          res.label,
          images: res.imageIds,
        );
        expect((r.sent.last['items'] as List).single['images'], [
          idOf(0),
          idOf(1),
        ]);
        // an edit replaces the pasted images and keeps the generated frame first
        final media = Comment(
          id: 'm',
          anchor: MediaAnchor(
            source: FileSource(kind: 'file', path: 'a.png'),
            width: 1,
            height: 1,
            shapes: const [],
          ),
          text: '',
          status: CommentStatus.pending,
          createdAt: 1,
          images: ['frame', 'p1'],
          genImages: 1,
        );
        r.event({
          'kind': 'comments',
          'items': [media.toJson()],
        });
        await t.pump();
        r.tab!.comments.edit('m', '', null, images: ['p2', 'p3']);
        expect(r.tab!.comments.all.firstWhere((c) => c.id == 'm').images, [
          'frame',
          'p2',
          'p3',
        ]);
        r.tab!.comments.edit('m', '', null, images: const []);
        expect(r.tab!.comments.all.firstWhere((c) => c.id == 'm').images, [
          'frame',
        ]);
        expect(x.images, [idOf(0), idOf(1)]);
      },
    );
  });
}
