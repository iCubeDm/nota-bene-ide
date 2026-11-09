import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/media/picker.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pickChannel, null);
  });

  void mock(Future<Object?> Function(MethodCall call) handler) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pickChannel, handler);
  }

  test('each source calls its own method', () async {
    final seen = <String>[];
    mock((call) async {
      seen.add(call.method);
      return <Object?>[];
    });
    for (final s in PickSource.values) {
      await pickImages(s);
    }
    expect(seen, ['camera', 'gallery', 'file']);
  });

  test('items are decoded, skipped names are kept apart', () async {
    mock(
      (call) async => <Object?>[
        {
          'bytes': Uint8List.fromList([1, 2, 3]),
          'mime': 'image/png',
          'name': 'a.png',
        },
        {'skipped': 'huge.jpg'},
        {
          'bytes': Uint8List.fromList([4]),
          'mime': 'image/jpeg',
          'name': 'b.jpg',
        },
      ],
    );
    final r = await pickImages(PickSource.gallery);
    expect(r.images.map((i) => i.name), ['a.png', 'b.jpg']);
    expect(r.images[0].bytes, Uint8List.fromList([1, 2, 3]));
    expect(r.images[0].mime, 'image/png');
    expect(r.skipped, ['huge.jpg']);
  });

  test('a cancelled pick is empty', () async {
    mock((call) async => <Object?>[]);
    final r = await pickImages(PickSource.file);
    expect(r.images, isEmpty);
    expect(r.skipped, isEmpty);
  });

  test('a null answer counts as cancelled', () async {
    mock((call) async => null);
    final r = await pickImages(PickSource.camera);
    expect(r.images, isEmpty);
  });
}
