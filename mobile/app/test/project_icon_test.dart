import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:nb_app/home.dart';
import 'package:nb_app/hosts/host_link.dart';
import 'package:nb_app/hosts/icon_flow.dart';
import 'package:nb_app/hosts/project_icon.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/media/attach.dart' show Prepared, UnsupportedImage;
import 'package:nb_app/media/picker.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/seen.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/fakes.dart';

final a = b64u(List.filled(32, 1));

/// A wide picture: red on the left half, blue on the right.
Uint8List wide() {
  final im = img.Image(width: 400, height: 200);
  for (final p in im) {
    p.r = p.x < 200 ? 255 : 0;
    p.g = 0;
    p.b = p.x < 200 ? 0 : 255;
    p.a = 255;
  }
  return Uint8List.fromList(img.encodePng(im));
}

Uint8List png1() =>
    Uint8List.fromList(img.encodePng(img.Image(width: 2, height: 2)));

HttpAnswer answer(
  int status, [
  List<int> body = const [],
  Map<String, String> headers = const {},
]) => (status: status, headers: headers, body: Uint8List.fromList(body));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('squareIcon', () {
    test('a wide picture is cut to its centre square of 256 px', () async {
      final p = await squareIcon(wide());
      expect(p.mime, 'image/png');
      expect(p.bytes.length, lessThanOrEqualTo(iconMaxBytes));
      final im = img.decodePng(p.bytes)!;
      expect((im.width, im.height), (256, 256));
      // the crop is x 50..150 of 200: the red half is on the left, the blue on the right
      expect(im.getPixel(10, 128).r, 255);
      expect(im.getPixel(245, 128).b, 255);
    });

    test('a picture that is not an image is refused', () async {
      await expectLater(
        squareIcon(Uint8List.fromList([1, 2, 3])),
        throwsA(isA<UnsupportedImage>()),
      );
    });

    test('noise too big as a PNG goes out as a JPEG within the cap', () async {
      final im = img.Image(width: 256, height: 256, numChannels: 4);
      final rnd = math.Random(7);
      for (final p in im) {
        p.r = rnd.nextInt(256);
        p.g = rnd.nextInt(256);
        p.b = rnd.nextInt(256);
        p.a = rnd.nextInt(256);
      }
      final p = await squareIcon(Uint8List.fromList(img.encodePng(im)));
      expect(p.mime, 'image/jpeg');
      expect(p.bytes.length, lessThanOrEqualTo(iconMaxBytes));
    });
  });

  group('the host calls', () {
    test(
      'PUT sends the picture with its type and returns the version',
      () async {
        final seen = <String>[];
        List<int>? sent;
        Map<String, String>? sentHeaders;
        Future<HttpAnswer> http(
          String m,
          String path, {
          Map<String, String>? headers,
          List<int>? body,
        }) async {
          seen.add('$m $path');
          sent = body;
          sentHeaders = headers;
          return answer(200, utf8.encode('{"icon":"0123456789abcdef"}'));
        }

        final v = await putProjectIcon(
          http,
          Prepared(Uint8List.fromList([1, 2]), 'image/png'),
        );
        expect(v, '0123456789abcdef');
        expect(seen, ['PUT /project-icon']);
        expect(sent, [1, 2]);
        expect(sentHeaders, {'content-type': 'image/png'});
      },
    );

    test('a refusal is an IconError', () async {
      Future<HttpAnswer> http(
        String m,
        String path, {
        Map<String, String>? headers,
        List<int>? body,
      }) async => answer(413);
      await expectLater(
        putProjectIcon(http, Prepared(Uint8List(1), 'image/png')),
        throwsA(isA<IconError>()),
      );
      await expectLater(deleteProjectIcon(http), throwsA(isA<IconError>()));
    });

    test('DELETE takes 204', () async {
      final seen = <String>[];
      await deleteProjectIcon((
        m,
        path, {
        Map<String, String>? headers,
        List<int>? body,
      }) async {
        seen.add('$m $path');
        return answer(204);
      });
      expect(seen, ['DELETE /project-icon']);
    });
  });

  group('ProjectIcons', () {
    test(
      'fetches a version once, keeps it, and does not cache a miss',
      () async {
        final icons = ProjectIcons();
        var n = 0;
        var status = 404;
        var etag = '';
        Future<HttpAnswer> http(
          String m,
          String path, {
          Map<String, String>? headers,
          List<int>? body,
        }) async {
          n++;
          return answer(status, [9, 9], {'etag': etag});
        }

        expect(await icons.load('v1', http), isNull);
        status = 200;
        etag = '"v1"';
        expect(await icons.load('v1', http), [9, 9]);
        expect(await icons.load('v1', http), [9, 9]);
        expect(n, 2);
        expect(await icons.load('v2', null), isNull); // offline
      },
    );

    test('keeps the newest versions within its capacity', () async {
      final icons = ProjectIcons(capacity: 2);
      var asked = '';
      Future<HttpAnswer> http(
        String m,
        String path, {
        Map<String, String>? headers,
        List<int>? body,
      }) async => answer(200, [1], {'etag': '"$asked"'});
      for (final v in ['a', 'b', 'c']) {
        asked = v;
        await icons.load(v, http);
      }
      expect(icons.cached('a'), isNull);
      expect(icons.cached('c'), isNotNull);
    });
  });

  group('screens', () {
    late Identity id;
    late Hosts hosts;
    late FakeFactory f;
    late Seen seen;

    setUp(() async {
      seen = await Seen.load(MemoryVault());
      final v = MemoryVault();
      id = await Identity.load(v);
      hosts = await Hosts.load(v);
      f = FakeFactory();
      await hosts.add(
        PairedHost(
          id: a,
          relay: Uri.parse('wss://relay.example.com'),
          label: 'laptop',
          pairedAt: DateTime(2026),
        ),
      );
    });

    Future<Links> pump(WidgetTester t) async {
      final links = Links(
        hosts,
        f.factory,
        id,
        sleep: (_) => Completer<void>().future,
      );
      await t.pumpWidget(
        NbApp(
          home: Home(
            hosts: hosts,
            seen: seen,
            links: links,
            onPair: () {},
            chat: (hostId, w) => const Scaffold(),
          ),
        ),
      );
      await t.pumpAndSettle();
      return links;
    }

    testWidgets(
      'a window with an icon shows the picture instead of the letter',
      (t) async {
        final ch = FakeChannel([
          window(4791, '/home/u/notes', title: 'Plan', icon: 'v-shows'),
        ]);
        ch.onHttp = (port, m, path) async => answer(200, png1());
        f.results.add(ch);
        final links = await pump(t);
        expect(find.byKey(const ValueKey('project-icon')), findsOneWidget);
        expect(find.text('C'), findsOneWidget); // only the small badge
        expect(ch.requests, contains('GET /project-icon'));
        links.dispose();
      },
    );

    testWidgets(
      'over a picture the provider letter stays as a small badge, and a screen reader hears the provider',
      (t) async {
        final handle = t.ensureSemantics();
        final ch = FakeChannel([
          window(4791, '/home/u/notes', title: 'Plan', icon: 'v-badge'),
        ]);
        ch.onHttp = (port, m, path) async => answer(200, png1());
        f.results.add(ch);
        final links = await pump(t);
        expect(find.byKey(const ValueKey('project-icon')), findsOneWidget);
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('provider-badge')),
            matching: find.text('C'),
          ),
          findsOneWidget,
        );
        expect(find.bySemanticsLabel(RegExp('Claude')), findsOneWidget);
        handle.dispose();
        links.dispose();
      },
    );

    testWidgets('the badge is not there without a picture', (t) async {
      final ch = FakeChannel([window(4791, '/home/u/notes', title: 'Plan')]);
      f.results.add(ch);
      final links = await pump(t);
      expect(find.byKey(const ValueKey('provider-badge')), findsNothing);
      links.dispose();
    });

    testWidgets('a poll that leaves the icon out keeps the last known one', (
      t,
    ) async {
      final ch = FakeChannel([
        window(4791, '/home/u/notes', title: 'Plan', icon: 'v-keep'),
      ]);
      f.results.add(ch);
      final links = await pump(t);
      final link = links.of(a)!;
      ch.push([window(4791, '/home/u/notes', title: 'Plan')]); // no field
      await t.pumpAndSettle();
      expect(link.windows.single.icon, 'v-keep');
      expect(link.windows.single.iconSupported, isTrue);
      ch.push([
        window(4791, '/home/u/notes', title: 'Plan', iconSupported: true),
      ]);
      await t.pumpAndSettle();
      expect(link.windows.single.icon, isNull); // a removal is said outright
      ch.push([
        window(4791, '/other', title: 'Plan'),
      ]); // another folder on the port
      await t.pumpAndSettle();
      expect(link.windows.single.iconSupported, isFalse);
      links.dispose();
    });

    testWidgets('no icon, or a fetch that fails: the letter stays', (t) async {
      final ch = FakeChannel([
        window(4791, '/home/u/notes', title: 'Plan', icon: 'v-fails'),
        window(4792, '/home/u/site', iconSupported: true),
      ]);
      ch.onHttp = (port, m, path) async => answer(404);
      f.results.add(ch);
      final links = await pump(t);
      expect(find.byKey(const ValueKey('project-icon')), findsNothing);
      expect(find.text('C'), findsNWidgets(2));
      links.dispose();
    });

    testWidgets(
      'the menu offers Set icon to a host that knows icons, Remove icon to a window that has one',
      (t) async {
        final ch = FakeChannel([
          window(4791, '/home/u/notes', title: 'Plan', iconSupported: true),
          window(4792, '/home/u/site', title: 'Site', icon: 'v-menu'),
          window(4793, '/home/u/old', title: 'Old'), // an older host: no field
        ]);
        ch.onHttp = (port, m, path) async => answer(404);
        f.results.add(ch);
        final links = await pump(t);
        Future<void> menu(String title) async {
          await t.longPress(find.text(title));
          await t.pumpAndSettle();
        }

        await menu('Plan');
        expect(find.text('Set icon'), findsOneWidget);
        expect(find.text('Remove icon'), findsNothing);
        await t.tapAt(const Offset(5, 5));
        await t.pumpAndSettle();
        await menu('Site');
        expect(find.text('Set icon'), findsOneWidget);
        expect(find.text('Remove icon'), findsOneWidget);
        await t.tapAt(const Offset(5, 5));
        await t.pumpAndSettle();
        await menu('Old');
        expect(find.text('Set icon'), findsNothing);
        expect(find.text('Remove icon'), findsNothing);
        expect(find.text('Mark read'), findsOneWidget);
        links.dispose();
      },
    );

    testWidgets(
      'Remove icon sends DELETE and asks the host for its windows again',
      (t) async {
        final ch = FakeChannel([
          window(4792, '/home/u/site', title: 'Site', icon: 'v-remove'),
        ]);
        ch.onHttp = (port, m, path) async =>
            m == 'DELETE' ? answer(204) : answer(404);
        f.results.add(ch);
        final links = await pump(t);
        await t.longPress(find.text('Site'));
        await t.pumpAndSettle();
        await t.tap(find.text('Remove icon'));
        await t.pumpAndSettle();
        expect(ch.requests, contains('DELETE /project-icon'));
        expect(ch.refreshes, 1);
        links.dispose();
      },
    );

    testWidgets('a failed removal ends in a snackbar', (t) async {
      final ch = FakeChannel([
        window(4792, '/home/u/site', title: 'Site', icon: 'v-remove-fail'),
      ]);
      ch.onHttp = (port, m, path) async => answer(m == 'DELETE' ? 500 : 404);
      f.results.add(ch);
      final links = await pump(t);
      await t.longPress(find.text('Site'));
      await t.pumpAndSettle();
      await t.tap(find.text('Remove icon'));
      await t.pumpAndSettle();
      expect(find.text('The icon could not be changed.'), findsOneWidget);
      links.dispose();
    });

    group('Set icon', () {
      void mockPick(Object? reply) {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(pickChannel, (call) async => reply);
        addTearDown(
          () => TestDefaultBinaryMessengerBinding
              .instance
              .defaultBinaryMessenger
              .setMockMethodCallHandler(pickChannel, null),
        );
      }

      Future<FakeChannel> rig(WidgetTester t) async {
        final ch = FakeChannel([
          window(4791, '/home/u/notes', title: 'Plan', iconSupported: true),
        ]);
        f.results.add(ch);
        return ch;
      }

      Future<void> start(WidgetTester t) async {
        await t.longPress(find.text('Plan'));
        await t.pumpAndSettle();
        await t.tap(find.text('Set icon'));
        await t.pumpAndSettle();
        await t.tap(find.text('Gallery'));
        await t.pumpAndSettle();
      }

      testWidgets(
        'the picked image goes out cut to a square, and the list is asked again',
        (t) async {
          final ch = await rig(t);
          ch.onHttp = (port, m, path) async =>
              answer(200, utf8.encode('{"icon":"0123456789abcdef"}'));
          mockPick([
            {'path': '/cache/p.jpg', 'mime': 'image/jpeg', 'name': 'p.jpg'},
          ]);
          final deleted = <String>[];
          final oldRead = readPickedFile, oldDelete = deletePickedFile;
          readPickedFile = (p) async => Uint8List.fromList([7, 7, 7]);
          deletePickedFile = (p) async => deleted.add(p);
          addTearDown(() {
            readPickedFile = oldRead;
            deletePickedFile = oldDelete;
          });
          final links = await pump(t);
          // the cut itself is squareIcon's test; here the flow is run with a stand-in for its isolate
          final link = links.of(a)!;
          final ctx = t.element(find.byType(Scaffold).first);
          unawaited(
            setProjectIconFlow(
              ctx,
              link,
              link.windows.first,
              square: (bytes) async => Prepared(bytes, 'image/png'),
            ),
          );
          await t.pumpAndSettle();
          await t.tap(find.text('Gallery'));
          await t.pumpAndSettle();
          final put = ch.calls.singleWhere((c) => c.method == 'PUT');
          expect(put.path, '/project-icon');
          expect(put.headers['content-type'], 'image/png');
          expect(put.body, [7, 7, 7]);
          expect(deleted, ['/cache/p.jpg']);
          expect(ch.refreshes, 1);
          links.dispose();
        },
      );

      testWidgets('cancelling the picker changes nothing and says nothing', (
        t,
      ) async {
        final ch = await rig(t);
        mockPick(<Object?>[]);
        final links = await pump(t);
        await start(t);
        expect(ch.requests, isEmpty);
        expect(find.byType(SnackBar), findsNothing);
        links.dispose();
      });

      testWidgets(
        'an image that is too large for the phone ends in a snackbar',
        (t) async {
          final ch = await rig(t);
          mockPick([
            {'skipped': 'huge.jpg'},
          ]);
          final links = await pump(t);
          await start(t);
          expect(ch.requests, isEmpty);
          expect(find.text('The icon could not be changed.'), findsOneWidget);
          links.dispose();
        },
      );

      testWidgets('a host that refuses the picture ends in a snackbar', (
        t,
      ) async {
        final ch = await rig(t);
        ch.onHttp = (port, m, path) async => answer(415);
        mockPick([
          {'path': '/cache/p.png', 'mime': 'image/png', 'name': 'p.png'},
        ]);
        final oldRead = readPickedFile, oldDelete = deletePickedFile;
        readPickedFile = (p) async => Uint8List.fromList([1]);
        deletePickedFile = (p) async {};
        addTearDown(() {
          readPickedFile = oldRead;
          deletePickedFile = oldDelete;
        });
        final links = await pump(t);
        final link = links.of(a)!;
        final ctx = t.element(find.byType(Scaffold).first);
        unawaited(
          setProjectIconFlow(
            ctx,
            link,
            link.windows.first,
            square: (b) async => Prepared(b, 'image/png'),
          ),
        );
        await t.pumpAndSettle();
        await t.tap(find.text('Gallery'));
        await t.pumpAndSettle();
        expect(find.text('The icon could not be changed.'), findsOneWidget);
        expect(ch.refreshes, 0);
        links.dispose();
      });
    });
  });
}
