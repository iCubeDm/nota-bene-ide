import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/window_sheet.dart';

void main() {
  test(
    'a name of several words goes on two lines, split nearest the middle',
    () {
      expect(twoLines('Default'), 'Default');
      expect(twoLines('Accept edits'), 'Accept\nedits');
      expect(twoLines('Принимать правки'), 'Принимать\nправки');
      expect(
        twoLines('Bypass all permission checks'),
        'Bypass all\npermission checks',
      );
    },
  );
}
