// What the app is built on (issue 511): its stores, the links to the paired hosts and what keeps them running, the
// phone's key and the background check. Made once by main.dart's `_load` and passed down; no store is a singleton of its own, so a test builds its
// own in memory.
import 'comments/queue.dart';
import 'hosts/host_link.dart';
import 'hosts/link_life.dart';
import 'store/project_icons.dart';
import 'notify/background.dart';
import 'store/hosts.dart';
import 'store/notified.dart';
import 'store/notify_choice.dart';
import 'store/unread.dart';
import 'store/storage.dart';
import 'voice/files.dart';
import 'voice/outbox.dart';

/// The app's stores, built on its [Storage]: what the vault keeps (the pairings, what was notified, the notification
/// choice), the voice outboxes and comment queues in its files, and in memory the project pictures fetched so far and
/// the chats read here.
class AppStores {
  AppStores({
    required this.hosts,
    required this.notified,
    required this.notify,
    required this.voice,
    required this.comments,
    required this.icons,
    required this.unread,
  });

  /// The stores kept in [s], the outboxes caching what they send in [sounds] (the player).
  static Future<AppStores> load(Storage s, {required Sounds sounds}) async =>
      AppStores(
        hosts: await Hosts.load(s.vault),
        notified: await Notified.load(s.vault),
        notify: await NotifyChoice.load(s.vault),
        voice: VoiceStore(s.files, sounds: sounds),
        comments: CommentQueues(s.files),
        icons: ProjectIcons(),
        unread: Unread(),
      );

  final Hosts hosts;
  final Notified notified;
  final NotifyChoice notify;
  final VoiceStore voice;
  final CommentQueues comments;
  final ProjectIcons icons;
  final Unread unread;
}

class Sdk {
  Sdk({
    required this.stores,
    required this.links,
    required this.life,
    required this.id,
    required this.background,
  });

  final AppStores stores;
  final Links links;
  final LinkLife life;
  final Identity id;
  final Background background;
}
