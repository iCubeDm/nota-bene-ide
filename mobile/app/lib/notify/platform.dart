// The Android side of keeping the links in the background (MainActivity's `nb/background` channel): the foreground
// service, the notifications, the periodic check and the notification permission.
import 'dart:async';

import 'package:flutter/services.dart';

import 'visible.dart' show ChatPlace;

const backgroundChannel = MethodChannel('nb/background');

abstract class BackgroundPlatform {
  /// `granted`, `denied` (asked and refused: only the system settings can change it) or `ask`.
  Future<String> permission();

  /// Asks Android; true when notifications are allowed after it.
  Future<bool> requestPermission();

  Future<void> startService(String title, String text, String channelName);
  Future<void> updateService(String title, String text);
  Future<void> stopService();

  /// Posts (or replaces, by [tag]) a notification that opens the chat of [hostId], [port] and [root].
  Future<void> notify({
    required String tag,
    required String title,
    String? text,
    required String publicTitle,
    required String hostId,
    required int port,
    required String root,
    required String channelName,
  });

  Future<void> cancel(String tag);

  /// Turns the 15-minute check on or off.
  Future<void> schedule(bool on);

  /// The app's notification settings in Android's settings.
  Future<void> openSettings();

  /// The headless check is over: Android may end its engine.
  Future<void> done();

  /// The chat of the notification that started the app, once; null when none did.
  Future<ChatPlace?> takeLaunch();

  /// The chat of a notification tapped while the app runs.
  Stream<ChatPlace> get opened;

  /// What the periodic check asks of a running app; answered when [check] completes.
  void onCheck(Future<void> Function() check);
}

class ChannelBackground implements BackgroundPlatform {
  ChannelBackground() {
    backgroundChannel.setMethodCallHandler(_fromAndroid);
  }

  final _opened = StreamController<ChatPlace>.broadcast();
  Future<void> Function()? _check;

  Future<Object?> _fromAndroid(MethodCall c) async {
    switch (c.method) {
      case 'opened':
        final place = _place(c.arguments);
        if (place != null) _opened.add(place);
      case 'check':
        await _check?.call();
    }
    return null;
  }

  static ChatPlace? _place(Object? a) {
    if (a is! Map) return null;
    final hostId = a['hostId'], port = a['port'], root = a['root'];
    if (hostId is! String || port is! int || root is! String) return null;
    return (hostId: hostId, port: port, root: root);
  }

  @override
  Future<String> permission() async =>
      await backgroundChannel.invokeMethod<String>('permission') ?? 'denied';

  @override
  Future<bool> requestPermission() async =>
      await backgroundChannel.invokeMethod<bool>('requestPermission') ?? false;

  @override
  Future<void> startService(String title, String text, String channelName) =>
      backgroundChannel.invokeMethod('startService', {
        'title': title,
        'text': text,
        'channel': channelName,
      });

  @override
  Future<void> updateService(String title, String text) => backgroundChannel
      .invokeMethod('updateService', {'title': title, 'text': text});

  @override
  Future<void> stopService() => backgroundChannel.invokeMethod('stopService');

  @override
  Future<void> notify({
    required String tag,
    required String title,
    String? text,
    required String publicTitle,
    required String hostId,
    required int port,
    required String root,
    required String channelName,
  }) => backgroundChannel.invokeMethod('notify', {
    'tag': tag,
    'title': title,
    'text': text,
    'publicTitle': publicTitle,
    'hostId': hostId,
    'port': port,
    'root': root,
    'channel': channelName,
  });

  @override
  Future<void> cancel(String tag) =>
      backgroundChannel.invokeMethod('cancel', {'tag': tag});

  @override
  Future<void> schedule(bool on) =>
      backgroundChannel.invokeMethod('schedule', {'on': on});

  @override
  Future<void> openSettings() => backgroundChannel.invokeMethod('openSettings');

  @override
  Future<void> done() => backgroundChannel.invokeMethod('done');

  @override
  Future<ChatPlace?> takeLaunch() async =>
      _place(await backgroundChannel.invokeMethod<Object?>('takeLaunch'));

  @override
  Stream<ChatPlace> get opened => _opened.stream;

  @override
  void onCheck(Future<void> Function() check) => _check = check;
}
