// The dictation a tab's voice control uses: the window's Whisper, or none while it has none (the mic then offers it).
import '../chat/window_tab.dart';
import '../files/image_screen.dart' show windowHttp;
import 'dictation.dart';
import 'host_dictation.dart';

Dictation? Function() voiceChooser(WindowTab tab) =>
    () => tab.whisper
    ? HostDictation(
        () => windowHttp(tab),
        onHostOff: () => tab.whisperOn = false,
      )
    : null;
