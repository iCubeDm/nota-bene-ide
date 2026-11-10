// Tabs like Telegram's chat folders: text labels, an underline that slides to the current one (and follows a swipe
// when [at] is a page position between two), an optional count badge on a label. As a [pill] the tabs float in a
// stadium like the chat header and the current one is a lighter stadium inside it.
import 'package:flutter/material.dart';

import '../theme.dart';

class FolderTabs extends StatelessWidget {
  const FolderTabs({
    super.key,
    required this.labels,
    required this.at,
    required this.onTap,
    this.badges = const {},
    this.subs = const {},
    this.pill = false,
  });
  final List<String> labels;

  /// The current position: 1.0 is the second tab, 1.5 halfway to the third.
  final double at;
  final void Function(int index) onTap;

  /// Index to count: a badge when the count is above 0.
  final Map<int, int> badges;

  /// Index to a second, smaller line under its label (the chat's mode); `danger` paints it in the danger colour.
  final Map<int, ({String text, bool danger})> subs;

  /// A floating stadium with a sliding lighter one for the current tab, instead of an underline.
  final bool pill;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    return LayoutBuilder(
      builder: (context, box) {
        final w = box.maxWidth / labels.length;
        final tabs = Stack(
          children: [
            if (pill)
              Positioned(
                left: at * w + 3,
                width: w - 6,
                top: 3,
                bottom: 3,
                child: DecoratedBox(
                  key: const ValueKey('strip-current'),
                  decoration: ShapeDecoration(
                    color: c.muted,
                    shape: const StadiumBorder(),
                  ),
                ),
              ),
            Row(
              children: [
                for (final (i, label) in labels.indexed)
                  Expanded(
                    child: InkWell(
                      customBorder: pill ? const StadiumBorder() : null,
                      onTap: () => onTap(i),
                      child: Center(
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Flexible(
                              child: FittedBox(
                                fit: BoxFit.scaleDown,
                                child: Column(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Text(
                                      label,
                                      style: TextStyle(
                                        fontSize: 14,
                                        fontWeight: FontWeight.w600,
                                        height: subs[i] == null ? null : 1.1,
                                        color: (at - i).abs() < .5
                                            ? c.foreground
                                            : c.mutedFg,
                                      ),
                                    ),
                                    if (subs[i] case final sub?)
                                      Text(
                                        sub.text,
                                        key: ValueKey('sub-$i'),
                                        style: TextStyle(
                                          fontSize: 10.5,
                                          height: 1.1,
                                          color: sub.danger
                                              ? c.destructive
                                              : c.mutedFg,
                                        ),
                                      ),
                                  ],
                                ),
                              ),
                            ),
                            if ((badges[i] ?? 0) > 0) ...[
                              const SizedBox(width: 6),
                              Container(
                                key: ValueKey('badge-$i'),
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 6,
                                  vertical: 1,
                                ),
                                decoration: BoxDecoration(
                                  color: c.accent,
                                  borderRadius: BorderRadius.circular(9),
                                ),
                                child: Text(
                                  '${badges[i]}',
                                  style: TextStyle(
                                    fontSize: 11,
                                    fontWeight: FontWeight.w700,
                                    color: c.background,
                                  ),
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                  ),
              ],
            ),
            if (!pill)
              Positioned(
                left: at * w + w * .2,
                width: w * .6,
                bottom: 0,
                height: 3,
                child: DecoratedBox(
                  key: const ValueKey('strip-underline'),
                  decoration: BoxDecoration(
                    color: c.primary,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
          ],
        );
        if (!pill) return tabs;
        return Material(
          color: c.popover.withValues(alpha: 0.92),
          shape: StadiumBorder(side: BorderSide(color: c.border)),
          clipBehavior: Clip.antiAlias,
          child: tabs,
        );
      },
    );
  }
}
