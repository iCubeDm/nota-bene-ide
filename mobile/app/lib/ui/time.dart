import '../l10n/app_localizations.dart';

/// How long ago, in words: just now, minutes, hours or days.
String ago(AppLocalizations t, Duration d) {
  if (d.inMinutes < 1) return t.justNow;
  if (d.inHours < 1) return t.minutesAgo(d.inMinutes);
  if (d.inDays < 1) return t.hoursAgo(d.inHours);
  return t.daysAgo(d.inDays);
}
