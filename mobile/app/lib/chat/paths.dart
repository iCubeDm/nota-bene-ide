// What a project path names, by its name alone (issue 511: apart from the screens that open it).

bool isMarkdownPath(String path) =>
    RegExp(r'\.(md|markdown)$', caseSensitive: false).hasMatch(path);

/// The sounds a reply embeds (the desktop's own list, `AUDIO` of shared/src/cutCheck.ts).
final soundPath = RegExp(r'\.(mp3|wav|m4a|ogg)$', caseSensitive: false);

/// [src] without its `?query` or `#fragment` (`shot.png?v=2` is `shot.png`; issue 459).
String embedPath(String src) => src.split(RegExp(r'[?#]')).first;

enum FileKind { markdown, image, video }

final _image = RegExp(r'\.(png|jpe?g|gif|webp|bmp)$', caseSensitive: false);
final _video = RegExp(r'\.(mp4|mov|webm|m4v)$', caseSensitive: false);

/// What the phone opens [path] as, or null when it does not open it.
FileKind? fileKindOf(String path) => isMarkdownPath(path)
    ? FileKind.markdown
    : _image.hasMatch(path)
    ? FileKind.image
    : _video.hasMatch(path)
    ? FileKind.video
    : null;
