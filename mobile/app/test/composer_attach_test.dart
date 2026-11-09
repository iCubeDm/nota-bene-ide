import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/composer.dart';
import 'package:nb_app/media/attach.dart';
import 'package:nb_app/media/picker.dart';

import 'support/rig.dart';

void main() {
  late Rig r;
  var n = 0;
  Completer<void>? hold;
  Object? pickError;
  List<Map<String, Object?>> picked = [];

  Map<String, Object?> item(String name, [String mime = 'image/png']) => {
    'bytes': Uint8List.fromList([1, 2, 3]),
    'mime': mime,
    'name': name,
  };

  setUp(() {
    r = Rig();
    n = 0;
    hold = null;
    pickError = null;
    picked = [item('a.png'), item('b.png')];
    prepareFor = (bytes, mime) async {
      if (!imageTypes.contains(mime)) throw UnsupportedImage(mime);
      return Prepared(bytes, mime);
    };
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pickChannel, (call) async {
          final e = pickError;
          if (e != null) throw e;
          return picked;
        });
  });
  tearDown(() {
    prepareFor = prepareImage;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pickChannel, null);
    r.dispose();
  });

  Future<void> open(WidgetTester t) async {
    await r.open(t);
    r.ch.onHttp = (port, method, path) async {
      await hold?.future;
      final id = (n++).toRadixString(16).padLeft(64, '0');
      return (
        status: 200,
        headers: const <String, String>{},
        body: Uint8List.fromList(
          utf8.encode(jsonEncode({'id': id, 'mediaType': 'image/png'})),
        ),
      );
    };
  }

  Future<void> attach(
    WidgetTester t,
    String source, {
    bool settle = true,
  }) async {
    await t.tap(find.byTooltip('Attach an image'));
    await t.pumpAndSettle();
    await t.tap(find.text(source));
    // a spinner never settles
    settle
        ? await t.pumpAndSettle()
        : await t.pump(const Duration(milliseconds: 100));
  }

  final thumbs = find.byKey(const ValueKey('draft'));
  IconButton send(WidgetTester t) =>
      t.widget<IconButton>(find.byKey(const ValueKey('send')));

  testWidgets('the paperclip offers camera, gallery and file', (t) async {
    await open(t);
    await t.tap(find.byTooltip('Attach an image'));
    await t.pumpAndSettle();
    expect(find.text('Camera'), findsOneWidget);
    expect(find.text('Gallery'), findsOneWidget);
    expect(find.text('File'), findsOneWidget);
  });

  testWidgets('two picked images show two thumbnails and upload', (t) async {
    await open(t);
    await attach(t, 'Gallery');
    expect(thumbs, findsNWidgets(2));
    expect(r.ch.calls.map((c) => '${c.method} ${c.path}'), [
      'POST /attach',
      'POST /attach',
    ]);
  });

  testWidgets('remove drops one', (t) async {
    await open(t);
    await attach(t, 'Gallery');
    await t.tap(find.byTooltip('Remove').first);
    await t.pumpAndSettle();
    expect(thumbs, findsOneWidget);
  });

  testWidgets('images without text are sent, labelled by position', (t) async {
    await open(t);
    await attach(t, 'Gallery');
    expect(send(t).onPressed, isNotNull);
    await t.tap(find.byKey(const ValueKey('send')));
    await t.pumpAndSettle();
    final m = r.sent.single;
    expect(m['text'], '');
    final images = (m['images'] as List).cast<Map>();
    expect(images.map((i) => i['id']), ['0' * 64, '0' * 63 + '1']);
    expect(images.map((i) => i['label']), ['[image 1]', '[image 2]']);
    expect(thumbs, findsNothing);
  });

  testWidgets('a refused send gives both images back', (t) async {
    await open(t);
    await t.enter('look');
    await attach(t, 'Gallery');
    await t.tap(find.byKey(const ValueKey('send')));
    await t.pumpAndSettle();
    expect(thumbs, findsNothing);
    r.event({
      'kind': 'send-refused',
      'id': r.sent.single['id'],
      'reason': 'busy',
    });
    await t.pumpAndSettle();
    expect(thumbs, findsNWidgets(2));
    expect(find.text('look'), findsOneWidget);
  });

  testWidgets('a send the tab cannot make keeps the images', (t) async {
    await open(t);
    await attach(t, 'Gallery');
    r.ch.drop();
    await t.pumpAndSettle();
    expect(thumbs, findsNWidgets(2));
  });

  testWidgets('send waits for a pending upload', (t) async {
    await open(t);
    hold = Completer<void>();
    await attach(t, 'Gallery', settle: false);
    expect(send(t).onPressed, isNull);
    expect(find.byType(CircularProgressIndicator), findsWidgets);
    hold!.complete();
    await t.pumpAndSettle();
    expect(send(t).onPressed, isNotNull);
  });

  testWidgets('a failed upload is marked and blocks send until removed', (
    t,
  ) async {
    await open(t);
    r.ch.onHttp = (port, method, path) async =>
        (status: 500, headers: const <String, String>{}, body: Uint8List(0));
    picked = [item('a.png')];
    await attach(t, 'File');
    expect(find.byKey(const ValueKey('draft-failed')), findsOneWidget);
    expect(find.text('The image could not be uploaded.'), findsOneWidget);
    await t.enter('words');
    expect(send(t).onPressed, isNull);
    await t.tap(find.byTooltip('Remove'));
    await t.pumpAndSettle();
    expect(send(t).onPressed, isNotNull);
  });

  testWidgets('an unsupported type is refused with a message', (t) async {
    await open(t);
    picked = [item('a.heic', 'image/heic')];
    await attach(t, 'File');
    expect(thumbs, findsNothing);
    expect(
      find.text('Only png, jpeg, gif and webp images can be attached.'),
      findsOneWidget,
    );
  });

  testWidgets('a picker error is told, by its code', (t) async {
    await open(t);
    pickError = PlatformException(code: 'denied');
    await attach(t, 'Camera');
    expect(thumbs, findsNothing);
    expect(find.byType(SnackBar), findsOneWidget);
    expect(find.textContaining('camera'), findsWidgets);
  });

  testWidgets('a skipped image is named as too large', (t) async {
    await open(t);
    picked = [
      {'skipped': 'huge.jpg'},
    ];
    await attach(t, 'Gallery');
    expect(find.textContaining('huge.jpg'), findsOneWidget);
  });

  testWidgets('the paperclip is off while the tab is not open', (t) async {
    await open(t);
    r.ch.drop();
    await t.pumpAndSettle();
    expect(
      t.widget<IconButton>(find.byKey(const ValueKey('attach'))).onPressed,
      isNull,
    );
    expect(find.byType(Composer), findsOneWidget);
  });
}
