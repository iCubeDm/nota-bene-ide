import 'dart:io';

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

  test('items are paths, skipped names are kept apart', () async {
    mock(
      (call) async => <Object?>[
        {'path': '/c/pick/1', 'mime': 'image/png', 'name': 'a.png'},
        {'skipped': 'huge.jpg'},
        {'path': '/c/pick/2', 'mime': 'image/jpeg', 'name': 'b.jpg'},
        {'bytes': Uint8List(1), 'mime': 'image/png', 'name': 'old.png'},
      ],
    );
    final r = await pickImages(PickSource.gallery);
    expect(r.images.map((i) => i.name), ['a.png', 'b.jpg']);
    expect(r.images[0].path, '/c/pick/1');
    expect(r.images[0].mime, 'image/png');
    expect(r.skipped, ['huge.jpg']);
  });

  test('a picked file is read lazily and deleted after its use', () async {
    final dir = Directory.systemTemp.createTempSync('nb-pick-test');
    addTearDown(() => dir.deleteSync(recursive: true));
    final f = File('${dir.path}/p')..writeAsBytesSync([7, 8, 9]);
    final p = PickedImage(path: f.path, mime: 'image/png', name: 'a.png');
    expect(await p.read(), Uint8List.fromList([7, 8, 9]));
    expect(f.existsSync(), isTrue); // reading does not consume it
    await p.delete();
    expect(f.existsSync(), isFalse);
    await p.delete(); // already gone: not an error
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
