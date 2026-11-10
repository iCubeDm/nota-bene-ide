import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:nb_app/chat/context_sheet.dart';
import 'package:nb_app/chat/window_sheet.dart';
import 'package:nb_app/comments/comment_sheet.dart';
import 'package:nb_app/home.dart';
import 'package:nb_app/hosts/host_link.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/settings_screen.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/seen.dart';
import 'package:nb_app/store/sizes.dart';
import 'package:nb_app/store/theme_choice.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/fakes.dart';
import 'support/rig.dart';

/// A 360 x 640 dp phone (pixel ratio 1), with a keyboard of [keyboard] px when given.
void phone(WidgetTester t, {double keyboard = 0}) {
  t.view.devicePixelRatio = 1;
  t.view.physicalSize = const Size(360, 640);
  t.view.viewInsets = FakeViewPadding(bottom: keyboard);
  addTearDown(t.view.reset);
}

Future<Sizes> sizesOf(double text, double ui, {Vault? vault}) async {
  final z = await Sizes.load(vault ?? MemoryVault());
  await z.chooseText(text);
  await z.chooseInterface(ui);
  return z;
}

Future<void> scrollTo(WidgetTester t, Finder f) =>
    t.scrollUntilVisible(f, 200, scrollable: find.byType(Scrollable).first);

void main() {
  setUpAll(() => initializeDateFormatting('en'));

  group('kept', () {
    test('default 100 %; the choices are kept; junk is not', () async {
      final v = MemoryVault();
      final a = await Sizes.load(v);
      expect((a.text, a.interface), (1.0, 1.0));
      await a.chooseText(1.35);
      await a.chooseInterface(1.15);
      final b = await Sizes.load(v);
      expect((b.text, b.interface), (1.35, 1.15));
      v.values['textSize'] = '3.0';
      v.values['interfaceSize'] = 'x';
      final c = await Sizes.load(v);
      expect((c.text, c.interface), (1.0, 1.0));
    });

    test('the steps: 85 to 150 % by 5; interface 90, 100, 115, 130', () {
      expect(textSizes.first, 0.85);
      expect(textSizes.last, 1.5);
      expect(textSizes, hasLength(14));
      expect(interfaceSizes, [0.9, 1.0, 1.15, 1.3]);
      expect(percent(1.15), '115 %');
      expect(percent(0.85), '85 %');
    });
  });

  group('applied', () {
    Future<void> show(
      WidgetTester t,
      Sizes? z,
      void Function(BuildContext) got,
    ) => t.pumpWidget(
      NbApp(
        sizes: z,
        home: Builder(
          builder: (c) {
            got(c);
            return const Scaffold(body: Text('abc', key: ValueKey('t')));
          },
        ),
      ),
    );

    testWidgets('the text scale multiplies the phone\'s own', (t) async {
      t.platformDispatcher.textScaleFactorTestValue = 1.2;
      addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
      late TextScaler got;
      final z = await sizesOf(1.5, 1.0);
      await show(t, z, (c) => got = MediaQuery.textScalerOf(c));
      expect(got.scale(10), closeTo(18, 1e-9));
      await z.chooseText(0.85);
      await t.pump();
      expect(got.scale(10), closeTo(10.2, 1e-9));
      final h = t.getSize(find.byKey(const ValueKey('t'))).height;
      await z.chooseText(1.5);
      await t.pump();
      expect(t.getSize(find.byKey(const ValueKey('t'))).height, greaterThan(h));
    });

    testWidgets('without sizes the phone\'s scale is untouched', (t) async {
      late TextScaler got;
      await show(t, null, (c) => got = MediaQuery.textScalerOf(c));
      expect(got.scale(10), 10);
    });

    testWidgets(
      'the interface is laid out at screen / s and painted s larger',
      (t) async {
        phone(t);
        late MediaQueryData mq;
        await show(t, await sizesOf(1, 1.3), (c) => mq = MediaQuery.of(c));
        expect(mq.size.width, closeTo(360 / 1.3, 1e-9));
        expect(mq.devicePixelRatio, closeTo(1.3, 1e-9));
        final r = t.getRect(find.byType(Scaffold).first);
        expect(r.size, const Size(360, 640));
      },
    );

    testWidgets('a tap at a scaled position hits the right control', (t) async {
      phone(t);
      final hits = <String>[];
      await t.pumpWidget(
        NbApp(
          sizes: await sizesOf(1, 1.3),
          home: Scaffold(
            body: Stack(
              children: [
                Positioned(
                  left: 20,
                  top: 20,
                  width: 100,
                  height: 50,
                  child: TextButton(
                    onPressed: () => hits.add('a'),
                    child: const Text('a'),
                  ),
                ),
                Positioned(
                  left: 20,
                  top: 90,
                  width: 100,
                  height: 50,
                  child: TextButton(
                    onPressed: () => hits.add('b'),
                    child: const Text('b'),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
      // laid out (20..120, 20..70) and (20..120, 90..140), shown 1.3 times larger
      expect(
        t.getRect(find.widgetWithText(TextButton, 'a')),
        const Rect.fromLTWH(26, 26, 130, 65),
      );
      // the middle of b in layout units, as the finger meets it on the screen
      await t.tapAt(const Offset(70 * 1.3, 115 * 1.3));
      // near the corner of a: inside it only when the scale is mapped (unscaled, this x is past its edge)
      await t.tapAt(const Offset(115 * 1.3, 65 * 1.3));
      expect(hits, ['b', 'a']);
    });

    testWidgets('the keyboard inset and the safe area shrink with the scale', (
      t,
    ) async {
      phone(t, keyboard: 260);
      t.view.padding = const FakeViewPadding(top: 26, bottom: 13);
      addTearDown(t.view.reset);
      late MediaQueryData mq;
      await t.pumpWidget(
        NbApp(
          sizes: await sizesOf(1, 1.3),
          home: Builder(
            builder: (c) {
              mq = MediaQuery.of(c);
              return const Scaffold(
                body: Align(
                  alignment: Alignment.bottomCenter,
                  child: TextField(key: ValueKey('f')),
                ),
              );
            },
          ),
        ),
      );
      await t.pump();
      expect(mq.viewInsets.bottom, closeTo(260 / 1.3, 1e-9));
      expect(mq.padding.top, closeTo(26 / 1.3, 1e-9));
      // the field rests on the keyboard on the screen, not under it
      expect(
        t.getRect(find.byKey(const ValueKey('f'))).bottom,
        lessThanOrEqualTo(640 - 260 + 0.5),
      );
      expect(
        t.getRect(find.byKey(const ValueKey('f'))).bottom,
        greaterThan(640 - 260 - 8),
      );
    });
  });

  group('Settings', () {
    Future<Sizes> settings(WidgetTester t, Vault v) async {
      final id = await Identity.load(v);
      final hosts = await Hosts.load(v);
      final z = await Sizes.load(v);
      await t.pumpWidget(
        NbApp(
          sizes: z,
          home: SettingsScreen(
            identity: id,
            hosts: hosts,
            themes: await ThemeChoice.load(v),
            sizes: z,
            onPair: () {},
          ),
        ),
      );
      await t.pumpAndSettle();
      return z;
    }

    testWidgets('a slider and four choices apply at once and are kept', (
      t,
    ) async {
      final v = MemoryVault();
      final z = await settings(t, v);
      await scrollTo(t, find.text('Text size'));
      expect(find.text('100 %'), findsNWidgets(2));
      final slider = find.byKey(const ValueKey('text-size'));
      final r = t.getRect(slider);
      await t.tapAt(Offset(r.right - 1, r.center.dy));
      await t.pump();
      expect(z.text, 1.5);
      expect(find.byKey(const ValueKey('text-size-value')), findsOneWidget);
      expect(find.text('150 %'), findsOneWidget);
      expect(await v.read('textSize'), '1.5');
      await t.tap(find.text('130 %'));
      await t.pumpAndSettle();
      expect(z.interface, 1.3);
      expect(await v.read('interfaceSize'), '1.3');
      expect((await Sizes.load(v)).interface, 1.3);
      expect(find.byKey(const ValueKey('size-preview')), findsOneWidget);
    });

    testWidgets('the preview line grows with both', (t) async {
      final z = await settings(t, MemoryVault());
      await scrollTo(t, find.byKey(const ValueKey('size-preview')));
      final h0 = t.getSize(find.byKey(const ValueKey('size-preview'))).height;
      await z.chooseText(1.5);
      await t.pump();
      expect(
        t.getSize(find.byKey(const ValueKey('size-preview'))).height,
        greaterThan(h0),
      );
    });
  });

  group('at 150 % text and 130 % interface on 360 x 640', () {
    testWidgets('home', (t) async {
      phone(t);
      final v = MemoryVault();
      final hosts = await Hosts.load(v);
      await hosts.add(
        PairedHost(
          id: b64u(List.filled(32, 1)),
          relay: Uri.parse('wss://relay.example.com'),
          label: 'a laptop with a rather long name',
          pairedAt: DateTime(2026),
        ),
      );
      final f = FakeFactory();
      f.results.add(
        FakeChannel([
          window(
            4791,
            '/home/u/notes',
            title: 'A long session title that wraps',
            model: 'opus',
            busy: true,
          ),
          window(4792, '/home/u/site'),
        ]),
      );
      final links = Links(
        hosts,
        f.factory,
        await Identity.load(v),
        sleep: (_) => Completer<void>().future,
      );
      await t.pumpWidget(
        NbApp(
          sizes: await sizesOf(1.5, 1.3),
          home: Home(
            hosts: hosts,
            seen: await Seen.load(MemoryVault()),
            clock: () => DateTime(2026, 11, 9),
            links: links,
            onPair: () {},
            chat: (_, _) => const Scaffold(),
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(find.text('A long session title that wraps'), findsOneWidget);
      links.dispose();
    });

    testWidgets('settings', (t) async {
      phone(t);
      final v = MemoryVault();
      final z = await sizesOf(1.5, 1.3, vault: v);
      await t.pumpWidget(
        NbApp(
          sizes: z,
          home: SettingsScreen(
            identity: await Identity.load(v),
            hosts: await Hosts.load(v),
            themes: await ThemeChoice.load(v),
            sizes: z,
            onPair: () {},
          ),
        ),
      );
      await t.pumpAndSettle();
      for (final k in ['text-size', 'interface-size', 'size-preview']) {
        await scrollTo(t, find.byKey(ValueKey(k)));
      }
    });

    testWidgets('the comment sheet', (t) async {
      phone(t);
      await t.pumpWidget(
        NbApp(
          sizes: await sizesOf(1.5, 1.3),
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () => showCommentSheet(
                context,
                quote: 'a quote that is rather long, to wrap over lines',
              ),
              child: const Text('open'),
            ),
          ),
        ),
      );
      await t.tap(find.text('open'));
      await t.pumpAndSettle();
      expect(find.byType(TextField), findsOneWidget);
    });

    testWidgets('the paragraph popup sits at its paragraph', (t) async {
      phone(t);
      final r = Rig()..sizes = await sizesOf(1.5, 1.3);
      addTearDown(r.dispose);
      await r.open(
        t,
        events: [
          {'kind': 'user', 'id': 'u1', 'text': 'Hello there', 'ts': 1},
          agent({
            't': 'message',
            'id': 'a1',
            'text': 'First one.\n\nThe second paragraph.\n\nThird.',
          }),
        ],
      );
      await t.tap(find.textContaining('The second'));
      await t.pumpAndSettle();
      final bubble = find.byKey(const ValueKey('para-labels'));
      expect(bubble, findsOneWidget);
      final para = t.getRect(find.textContaining('The second'));
      // above the paragraph, as it is shown (the screen), and within it sideways
      expect(t.getRect(bubble).bottom, lessThanOrEqualTo(para.top + 1));
      expect(t.getRect(bubble).left, greaterThanOrEqualTo(0));
      expect(t.getRect(bubble).right, lessThanOrEqualTo(360));
      expect(
        t.getRect(find.byKey(const ValueKey('para-bar'))).top,
        greaterThanOrEqualTo(para.bottom - 1),
      );
    });

    group('chat', () {
      late Rig r;
      setUp(() {
        r = Rig();
      });
      tearDown(() => r.dispose());

      Future<void> chat(WidgetTester t) async {
        phone(t);
        r.sizes = await sizesOf(1.5, 1.3);
        await r.open(
          t,
          events: [
            {
              'kind': 'session',
              'id': 's',
              'root': '/home/u/notes',
              'title': 'Spec work',
              'model': 'sonnet',
            },
          ],
        );
      }

      testWidgets('the chat with its composer', (t) async {
        await chat(t);
        expect(find.byKey(const ValueKey('composer')), findsOneWidget);
        await t.enterText(find.byType(TextField), 'a long message ' * 8);
        await t.pump();
      });

      testWidgets('the context sheet', (t) async {
        await chat(t);
        await r.openContextSheet(t);
        expect(find.byType(ContextSheet), findsOneWidget);
      });

      testWidgets('the window sheet', (t) async {
        await chat(t);
        await t.tap(find.text('Spec work'));
        await t.pumpAndSettle();
        expect(find.byType(WindowSheet), findsOneWidget);
      });
    });
  });
}
