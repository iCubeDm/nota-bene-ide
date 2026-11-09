import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:nb_app/chat/window_sheet.dart';

void main() {
  setUpAll(() async {
    await initializeDateFormatting('en');
    await initializeDateFormatting('ru');
  });
  test('the reset time: HH:mm today, else the weekday and the time', () {
    final now = DateTime(2026, 11, 9, 10);
    expect(resetWhen('2026-11-09T17:30:00', now, 'en'), '17:30');
    expect(resetWhen('2026-11-12T17:30:00', now, 'en'), 'Thu 17:30');
    expect(resetWhen(null, now, 'en'), isNull);
    expect(resetWhen('nope', now, 'en'), isNull);
  });

  test('the reset time in the UI locale', () {
    final now = DateTime(2026, 11, 9, 10);
    expect(resetWhen('2026-11-09T17:30:00', now, 'ru'), '17:30');
    expect(resetWhen('2026-11-12T17:30:00', now, 'ru'), 'чт 17:30');
  });
}
