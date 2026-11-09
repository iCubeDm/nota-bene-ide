// Which dictation a tab's voice control uses: the host's Whisper when it has one, else the phone's recognizer.
import '../chat/window_tab.dart';
import '../files/image_screen.dart' show windowHttp;
import 'dictation.dart';
import 'host_dictation.dart';

Dictation Function() voiceChooser(WindowTab tab) =>
    () =>
        tab.state == TabState.open &&
            tab.capabilities?.dictation == 'whisper' &&
            !tab.hostWhisperOff
        ? HostDictation(
            () => windowHttp(tab),
            onHostOff: () => tab.hostWhisperOff = true,
          )
        : dictation;
