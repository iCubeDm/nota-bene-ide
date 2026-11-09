// The host's voice routes: `POST /voice` stores a recording and answers its id, length and wave; `GET /voice/<id>` is
// the audio; `POST /voice/<id>/text` transcribes a stored one (the comment clips use it).
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart' show ScaffoldMessenger, SnackBar, Text;
import 'package:flutter/widgets.dart' show BuildContext, Localizations;
import 'package:nb_channel/nb_channel.dart' show HttpAnswer;
import 'package:nb_protocol/nb_protocol.dart' show Voice, VoiceError;

import '../chat/files.dart' show FileOpener;
import '../chat/window_tab.dart';
import '../files/image_screen.dart' show windowHttp;
import '../l10n/app_localizations.dart';
import '../media/media_comment.dart';
import 'player.dart';

class VoiceUploadError implements Exception {
  VoiceUploadError(this.why);
  final String why;
  @override
  String toString() => 'VoiceUploadError($why)';
}

// a long recording over a slow relay: the body is up to 20 MB
const _uploadTimeout = Duration(minutes: 3);
// the first part of a transcription may wait for the model to load, and for the transcriptions queued before it
const _textTimeout = Duration(minutes: 5);

/// Stores [wav] on the host (`audio/wav`, as `nb/record` writes it).
Future<Voice> uploadVoice(WindowHttp http, Uint8List wav) async {
  final HttpAnswer r;
  try {
    r = await http(
      'POST',
      '/voice',
      headers: {'content-type': 'audio/wav'},
      body: wav,
    ).timeout(_uploadTimeout);
  } on Object catch (e) {
    throw VoiceUploadError('$e');
  }
  if (r.status != 200) throw VoiceUploadError('${r.status}');
  try {
    return Voice.fromJson(
      (jsonDecode(utf8.decode(r.body)) as Map).cast<String, Object?>(),
    );
  } on Object {
    throw VoiceUploadError('answer');
  }
}

/// A clip's text, or why there is none: `off` while the host's Whisper is off (503), `empty` when nothing was heard,
/// `failed` for anything else.
Future<({String? text, VoiceError? error})> transcribeClip(
  WindowHttp http,
  String id,
  String lang,
) async {
  try {
    final r = await http(
      'POST',
      '/voice/$id/text?lang=${Uri.encodeQueryComponent(lang)}',
    ).timeout(_textTimeout);
    if (r.status == 503) return (text: null, error: VoiceError.off);
    if (r.status != 200) return (text: null, error: VoiceError.failed);
    final text = (jsonDecode(utf8.decode(r.body)) as Map)['text'];
    if (text is! String) return (text: null, error: VoiceError.failed);
    return text.trim().isEmpty
        ? (text: null, error: VoiceError.empty)
        : (text: text.trim(), error: null);
  } on Object {
    return (text: null, error: VoiceError.failed);
  }
}

/// How the player fetches voice [id] of [tab]'s window.
LoadVoice voiceLoader(WindowTab? tab, String id) => () async {
  final http = tab == null ? null : windowHttp(tab);
  if (http == null) return null;
  try {
    final r = await http('GET', '/voice/$id');
    return r.status == 200 ? Uint8List.fromList(r.body) : null;
  } on Object {
    return null;
  }
};

/// The Retry of a failed voice bubble: the same recording as a new message, once. Says so when the window is out of
/// reach.
void retryVoice(BuildContext context, Voice voice) {
  final tab = FileOpener.of(context);
  if (tab == null) return;
  final lang = Localizations.localeOf(context).languageCode;
  if (!tab.retryVoice(voice, lang)) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(AppLocalizations.of(context).cannotSend)),
    );
  }
}
