import 'package:flutter/services.dart';

// A frame of a video at a time, taken by Android's MediaMetadataRetriever (MainActivity's `nb/frame` channel),
// read from the URL the player plays (the app's loopback proxy).
const frameChannel = MethodChannel('nb/frame');

/// The frame of [url] at [at] as PNG with its size; a [PlatformException] when Android could not take it.
Future<({Uint8List png, int width, int height})> frameAt(
  Uri url,
  Duration at,
) async {
  final reply = await frameChannel.invokeMapMethod<String, Object?>('frameAt', {
    'url': '$url',
    'us': at.inMicroseconds,
  });
  final png = reply?['png'];
  final width = reply?['width'];
  final height = reply?['height'];
  if (png is! Uint8List || width is! int || height is! int) {
    throw PlatformException(code: 'frame', message: 'bad reply');
  }
  return (png: png, width: width, height: height);
}
