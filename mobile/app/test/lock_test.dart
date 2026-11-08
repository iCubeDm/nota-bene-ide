import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/lock/lock.dart';
import 'package:nb_app/main.dart';

class FakeAuth implements Authenticator {
  final results = <AuthResult>[];
  var asked = 0;
  @override
  Future<AuthResult> authenticate(String reason) async {
    asked++;
    return results.isEmpty ? AuthResult.ok : results.removeAt(0);
  }
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

    Future<void> away(Duration d) async {
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      now = now.add(d);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await t.pumpAndSettle();
    }

    await away(const Duration(minutes: 4));
    expect(auth.asked, 1);
    expect(find.text('inside'), findsOneWidget);
    await away(const Duration(minutes: 5));
    expect(auth.asked, 2);
    expect(
      find.text('inside'),
      findsOneWidget,
      reason: 'the second check passed',
    );
  });
}
