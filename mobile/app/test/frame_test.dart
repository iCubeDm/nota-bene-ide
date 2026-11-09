import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/media/frame.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(frameChannel, null);
  });

  void mock(Future<Object?> Function(MethodCall call) handler) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(frameChannel, handler);
  }

  test(
    'asks Android for the frame at the time and returns the PNG and size',
    () async {
      MethodCall? seen;
      mock((call) async {
        seen = call;
        return {
          'png': Uint8List.fromList([1, 2]),
          'width': 720,
          'height': 1280,
        };
      });

      final frame = await frameAt(
        Uri.parse('http://127.0.0.1:5/t'),
        const Duration(milliseconds: 61500),
      );

      expect(seen?.method, 'frameAt');
      expect(seen?.arguments, {'url': 'http://127.0.0.1:5/t', 'us': 61500000});
      expect(frame.png, Uint8List.fromList([1, 2]));
      expect(frame.width, 720);
      expect(frame.height, 1280);
    },
  );

  test(
    'a native failure surfaces as a PlatformException with its code',
    () async {
      mock((call) async {
        throw PlatformException(code: 'frame', message: 'no frame');
      });

      await expectLater(
        frameAt(Uri.parse('http://127.0.0.1:5/t'), Duration.zero),
        throwsA(
          isA<PlatformException>().having((e) => e.code, 'code', 'frame'),
        ),
      );
    },
  );

  test('a malformed reply is rejected as a bad reply', () async {
    mock((call) async => {'png': null, 'width': 1, 'height': 1});

    await expectLater(
      frameAt(Uri.parse('http://127.0.0.1:5/t'), Duration.zero),
      throwsA(
        isA<PlatformException>()
            .having((e) => e.code, 'code', 'frame')
            .having((e) => e.message, 'message', 'bad reply'),
      ),
    );
  });
}
