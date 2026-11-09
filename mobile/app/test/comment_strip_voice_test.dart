import 'package:flutter_test/flutter_test.dart';

import 'support/rig.dart';

void main() {
  testWidgets(
    'a pending comment in the strip shows its clips after the typed text',
    (t) async {
      final r = Rig();
      addTearDown(r.dispose);
      await r.open(t);
      r.event({
        'kind': 'comments',
        'items': [
          {
            'id': 'c1',
            'anchor': {
              'source': {'path': 'a.md'},
              'start': 0,
              'end': 3,
              'quote': 'foo',
              'prefix': '',
              'suffix': '',
            },
            'text': 'typed',
            'status': 'pending',
            'createdAt': 1,
            'voice': [
              {
                'text': 'said this',
                'id': 'a' * 64,
                'ms': 1000,
                'wave': List.filled(48, 1),
              },
            ],
          },
        ],
        'ts': 1,
      });
      await t.pumpAndSettle();
      expect(
        find.textContaining('typed said this', findRichText: true),
        findsOneWidget,
      );
    },
  );
}
