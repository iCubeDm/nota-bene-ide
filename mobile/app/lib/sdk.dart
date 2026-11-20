// What the app is built on (issue 511): its stores, the links to the paired hosts, the phone's key and the background
// check. Made once by main.dart's `_load` and passed down; no store is a singleton of its own, so a test builds its
// own in memory.
import 'comments/queue.dart';
import 'hosts/host_link.dart';
import 'hosts/project_icon.dart';
import 'notify/background.dart';
import 'store/hosts.dart';
import 'store/notified.dart';
import 'store/notify_choice.dart';
import 'store/seen.dart';
import 'store/vault.dart';
import 'voice/files.dart';
import 'voice/outbox.dart';

/// The app's stores: what the vault keeps (the pairings, what was seen and notified, the notification choice), the
/// voice outboxes and comment queues on the phone's disk, and the project pictures fetched so far.
class AppStores {
  AppStores({
    required this.hosts,
    required this.seen,
    required this.notified,
    required this.notify,
    required this.voice,
    required this.comments,
    required this.icons,
  });

  /// The stores of [v]; the outboxes and the comment queues on [outFiles] and [queueFile] (the phone's disk without
  /// them), the outboxes caching what they send in [sounds] (the player).
  static Future<AppStores> load(
    Vault v, {
    required Sounds sounds,
    OutFiles? outFiles,
    QueueFile? queueFile,
  }) async => AppStores(
    hosts: await Hosts.load(v),
    seen: await Seen.load(v),
    notified: await Notified.load(v),
    notify: await NotifyChoice.load(v),
    voice: VoiceStore(outFiles ?? DiskOutFiles(), sounds: sounds),
    comments: CommentQueues(queueFile ?? DiskQueueFile()),
    icons: ProjectIcons(),
  );

  final Hosts hosts;
  final Seen seen;
  final Notified notified;
  final NotifyChoice notify;
  final VoiceStore voice;
  final CommentQueues comments;
  final ProjectIcons icons;
}

class Sdk {
  Sdk({
    required this.stores,
    required this.links,
    required this.id,
    required this.background,
  });

  final AppStores stores;
  final Links links;
  final Identity id;
  final Background background;
}
