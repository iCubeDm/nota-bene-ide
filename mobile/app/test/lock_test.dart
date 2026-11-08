import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/lock/lock.dart';
import 'package:nb_app/main.dart';

class FakeAuth implements Authenticator {
  final results = <AuthResult>[];
  var asked = 0;
  AuthTexts? texts;
  @override
  Future<AuthResult> authenticate(AuthTexts t) async {
    asked++;
    texts = t;
    return results.isEmpty ? AuthResult.ok : results.removeAt(0);
  }
}

var mounts = 0;

class _Counted extends StatefulWidget {
  const _Counted();
  @override
  State<_Counted> createState() => _CountedState();
}

class _CountedState extends State<_Counted> {
  @override
  void initState() {
    super.initState();
    mounts++;
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: TextButton(
      onPressed: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => const Scaffold(body: Text('pushed chat')),
        ),
      ),
      child: const Text('home page'),
    ),
  );
}

void main() {
  late DateTime now;
  setUp(() => now = DateTime(2026, 11, 8, 12));

  Future<void> pump(WidgetTester t, FakeAuth auth) async {
    await t.pumpWidget(
      NbApp(
        home: LockGate(
          authenticator: auth,
          clock: () => now,
          child: const Text('inside'),
        ),
      ),
    );
    await t.pumpAndSettle();
  }

  Future<void> away(WidgetTester t, Duration d) async {
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    now = now.add(d);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await t.pumpAndSettle();
  }

  testWidgets('the lock covers a pushed route and keeps the app mounted', (
    t,
  ) async {
    mounts = 0;
    final auth = FakeAuth();
    await t.pumpWidget(
      NbApp(
        home: const _Counted(),
        lock: (nav) =>
            LockGate(authenticator: auth, clock: () => now, child: nav),
      ),
    );
    await t.pumpAndSettle();
    await t.tap(find.text('home page'));
    await t.pumpAndSettle();
    expect(find.text('pushed chat'), findsOneWidget);
    auth.results.add(AuthResult.failed);
    await away(t, const Duration(minutes: 6));
    expect(
      find.text('pushed chat'),
      findsNothing,
      reason: 'the chat is hidden behind the lock',
    );
    expect(find.text('Unlock'), findsOneWidget);
    await t.tap(find.text('Unlock'));
    await t.pumpAndSettle();
    expect(
      find.text('pushed chat'),
      findsOneWidget,
      reason: 'and comes back where it was',
    );
    expect(mounts, 1, reason: 'the app below is never rebuilt from scratch');
  });

  testWidgets('the system dialog gets the texts in the app language', (
    t,
  ) async {
    final auth = FakeAuth();
    await pump(t, auth);
    expect(auth.texts?.reason, 'Unlock to reach your sessions');
    expect(auth.texts?.title, 'Nota Bene is locked');
    expect(auth.texts?.cancel, 'Cancel');
  });

  testWidgets('LockGate shows the child only after authenticate succeeds', (
    t,
  ) async {
    final auth = FakeAuth()..results.add(AuthResult.failed);
    await pump(t, auth);
    expect(find.text('inside'), findsNothing);
    expect(find.text('Not unlocked. Try again.'), findsOneWidget);
    await t.tap(find.text('Unlock'));
    await t.pumpAndSettle();
    expect(find.text('inside'), findsOneWidget);
    expect(auth.asked, 2);
  });

  testWidgets('a phone without a screen lock does not open', (t) async {
    final auth = FakeAuth()..results.add(AuthResult.unavailable);
    await pump(t, auth);
    expect(find.text('inside'), findsNothing);
    expect(find.textContaining('no screen lock'), findsOneWidget);
  });

  testWidgets('5 minutes in the background locks again, 4 do not', (t) async {
    final auth = FakeAuth();
    await pump(t, auth);
    expect(find.text('inside'), findsOneWidget);

    await away(t, const Duration(minutes: 4));
    expect(auth.asked, 1);
    expect(find.text('inside'), findsOneWidget);
    await away(t, const Duration(minutes: 5));
    expect(auth.asked, 2);
    expect(
      find.text('inside'),
      findsOneWidget,
      reason: 'the second check passed',
    );
  });
}
