import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/vault.dart';

PairedHost host(String id, {String label = 'proj'}) => PairedHost(
  id: id,
  relay: Uri.parse('wss://relay.example.com'),
  label: label,
  pairedAt: DateTime.utc(2026, 11, 8),
);

void main() {
  test('the identity is created once and kept', () async {
    final v = MemoryVault();
    final a = await Identity.load(v);
    final b = await Identity.load(v);
    expect(a.key.pub, hasLength(32));
    expect(b.key.pub, a.key.pub);
    expect(b.key.priv, a.key.priv);
    expect(
      await a.fingerprint,
      matches(RegExp(r'^[a-z2-7]{4}(-[a-z2-7]{4}){3}$')),
    );
    expect(
      await Identity.load(MemoryVault()).then((i) => i.key.pub),
      isNot(a.key.pub),
    );
  });

  test('hosts survive a reload and forget removes one', () async {
    final v = MemoryVault();
    final h = await Hosts.load(v);
    await h.add(host('A'));
    await h.add(host('B', label: 'other'));
    await h.add(host('A', label: 'renamed')); // the same host again replaces it
    await h.setLastChat('A 4791 /p');
    final again = await Hosts.load(v);
    expect(again.all.map((e) => (e.id, e.label)), [
      ('A', 'renamed'),
      ('B', 'other'),
    ]);
    expect(again.all.first.relay, Uri.parse('wss://relay.example.com'));
    expect(again.lastChat, 'A 4791 /p');
    await again.forget('A');
    expect((await Hosts.load(v)).all.map((e) => e.id), ['B']);
    expect(
      (await Hosts.load(v)).lastChat,
      isNull,
      reason: 'the last chat went with its host',
    );
  });

  test(
    'a corrupt nb.hosts is treated as empty and not overwritten until a change',
    () async {
      final v = MemoryVault()..values['nb.hosts'] = '{not json';
      final h = await Hosts.load(v);
      expect(h.all, isEmpty);
      expect(v.values['nb.hosts'], '{not json');
      await h.add(host('C'));
      expect((await Hosts.load(v)).all.single.id, 'C');
    },
  );

  test('a corrupt identity is an error, never a silent new key', () async {
    final v = MemoryVault()..values['nb.identity'] = 'garbage';
    await expectLater(Identity.load(v), throwsA(isA<VaultCorrupt>()));
    expect(v.values['nb.identity'], 'garbage');
  });

  test('notifies listeners on change', () async {
    final h = await Hosts.load(MemoryVault());
    var n = 0;
    h.addListener(() => n++);
    await h.add(host('A'));
    await h.forget('A');
    expect(n, 2);
  });
}
