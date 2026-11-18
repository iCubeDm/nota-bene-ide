# Android and Material Design 3 (Expressive) guidelines for a content-heavy chat-and-documents Flutter app (state as of Nov 2026)

Research note. Sourcing caveat: m3.material.io pages are JS-rendered and returned nothing, so M3 specifics rely on developer.android.com, Flutter docs/issues and secondary sources, flagged below. Unsourced items are in Gaps.

## 1. Navigation: tabs vs swipeable panes, predictive back, app bars, adaptive layouts

**Takeaway.** Material allows switching tabs by tap or content swipe but warns against pairing tab swipe with content that swipes itself (maps, swipeable list items). On Android 16 (targetSdk 36) predictive back is on by default and apps must handle back through supported APIs (Flutter: `PopScope` plus manifest flag). Window size classes: compact <600, medium 600-839, expanded 840-1199 dp; the app's 840 dp three-pane threshold equals "expanded".

**Findings**
- Tabs switch by tap or swipe over content, including fixed tabs (M2 guidance; M3 page not retrievable) ([M2 tabs](https://m2.material.io/go/design-tabs)). Material warns against pairing tabs with content that also swipes ([M1 tabs](https://m1.material.io:443/components/tabs.html), M2). Android's swipe-view implementation is ViewPager2 + tab layout ([guide](https://developer.android.com/guide/navigation/navigation-swipe-view-2)).
- System gesture insets (Android 10+): bottom inset for home gesture, left/right for back. Use them "to move or pad swipeable views away from the edges" (bottom sheets, carousels, ViewPager2) ([edge-to-edge](https://developer.android.com/develop/ui/views/layout/edge-to-edge)). Avoid touch targets under gesture insets ([system bars](https://developer.android.com/design/ui/mobile/guides/foundations/system-bars)).
- Predictive back, API 36 on Android 16+: back animations on by default; `onBackPressed` is not called. Opt-out `android:enableOnBackInvokedCallback="false"` ([Android 16](https://developer.android.com/about/versions/16/behavior-changes-16)). A callback with PRIORITY_DEFAULT/OVERLAY suppresses the animations; PRIORITY_SYSTEM_NAVIGATION_OBSERVER observes without consuming ([guide](https://developer.android.com/guide/navigation/predictive-back-gesture), search summary only).
- Flutter: set `android:enableOnBackInvokedCallback="true"`; `PopScope` (`onPopInvokedWithResult`) replaces `WillPopScope`; `canPop:false` intercepts; `PredictiveBackPageTransitionsBuilder` in `PageTransitionsTheme` gives the page animation ([Flutter](https://docs.flutter.dev/platform-integration/android/predictive-back.md), [breaking change](https://docs.flutter.dev/release/breaking-changes/android-predictive-back)).
- Width classes: compact <600; medium 600-<840; expanded 840-<1200; large 1200-<1600; extra-large >=1600. Height: compact <480; medium 480-<900; expanded >=900. 99.78% of phones in landscape are <480 dp tall; two panes are not practical at compact height ([size classes](https://developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes)).
- Decide layout from window metrics, not device type; the class changes at runtime (rotation, split screen, fold); hoist state (e.g. selected pane) so it survives layout switches ([size classes](https://developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes), [display sizes](https://developer.android.com/develop/ui/compose/layouts/adaptive/support-different-display-sizes)).
- Android 16 (targetSdk 36): orientation/resizability/aspect restrictions are ignored when smallest width >= 600 dp; the opt-out is temporary and not honoured for targetSdk 37 ([Android 16](https://developer.android.com/about/versions/16/behavior-changes-16)). Play requires targeting API 36 from 2026-08-31 ([Play](https://developer.android.com/google/play/requirements/target-sdk)), so edge-to-edge is forced and predictive back is default.
- Adaptive navigation: switch bar/rail by size class; canonical layouts (list-detail, supporting pane) are recommended ([system bars](https://developer.android.com/design/ui/mobile/guides/foundations/system-bars)).
- M3 Expressive "floating toolbar" (page actions, vertical variant), button groups, FAB menu, split button, loading indicator: secondary sources only ([9to5Google](https://9to5google.com/2025/05/18/material-3-expressive-toolbars/), [Compose M3E](https://composables.com/material-3-expressive), [flutter#168813](https://github.com/flutter/flutter/issues/168813)). A floating pill header/tabs is not an official M3 app-bar pattern; no official guidance on pill-shaped floating navigation tabs.

**Inferences**
- Swiping a PageView across Files/Chat/Comments conflicts with the edge back gesture, horizontal scrolling in code/diff/table viewers, and text selection handles. Material's caution supports restricting swipe or giving viewers priority.
- Mitigate: tabs tappable as primary; disable page swipe while a child horizontal scrollable can scroll (nested `NotificationListener`/`ScrollPhysics`, or enable swipe only from the pill/header strip or at child scroll extent); inset swipe regions by `MediaQuery.systemGestureInsets`; sheets/viewers go on top of the back stack with `PopScope`.
- Choose panes by width AND minimum height: a landscape phone (~800-900 wide, <480 tall) is medium/expanded width but compact height. Pill tabs make sense only where panes collapse.
- On tablets (sw >= 600) with targetSdk 36 orientation cannot be locked; layout must survive rotation/resize with preserved composer draft, scroll positions, recording state.

**Gaps.** Official M3 text on tab swiping, floating toolbar and button-group specs; no statement on when pane swiping is discouraged beyond the old caution; back-gesture edge width in dp is OEM-specific.

## 2. Edge-to-edge, insets, IME, cutouts

**Takeaway.** Edge-to-edge is forced for targetSdk >=35 and the opt-out is removed for targetSdk 36 on Android 16. Flutter 3.27+ targets 35 and defaults to `SystemUiMode.edgeToEdge`. Handle system-bar, cutout and IME insets explicitly; keep the gesture nav bar transparent.

**Findings**
- `windowOptOutEdgeToEdgeEnforcement` is deprecated and disabled for targetSdk 36 on Android 16 (still works on Android 15) ([edge-to-edge](https://developer.android.com/develop/ui/views/layout/edge-to-edge), [Android 16](https://developer.android.com/about/versions/16/behavior-changes-16)).
- Insets: system bars, display cutout, system gestures. Apps draw into the cutout by default: pad with `systemBars | displayCutout`, `clipToPadding=false` so content scrolls behind bars. Full-screen dialogs must be edge-to-edge too. Desktop windowing always shows a caption bar (`captionBar()` inset).
- Gesture nav bar stays transparent; 3-button bar gets a translucent scrim (`setNavigationBarContrastEnforced(false)` removes it); transparent 3-button bar when a bottom bar sits there, translucent when scrolling content goes under. Protection behind the status bar should match the pane background ([system bars](https://developer.android.com/design/ui/mobile/guides/foundations/system-bars)).
- Sync app transitions with the keyboard via `WindowInsetsAnimationCompat`.
- Flutter: default `flutter.targetSdkVersion` targets 15 from 3.27; `SystemUiMode.edgeToEdge` is default; opt-out works only on Android 15 ([breaking change](https://docs.flutter.dev/release/breaking-changes/default-systemuimode-edge-to-edge)). Third-party pitfall: Scaffold body under nav bar after targeting 35; fix with SafeArea/MediaQuery padding, not opt-out ([startdebugging](https://startdebugging.net/ru/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/)).

**Inferences**
- Floating pill header offset by `MediaQuery.viewPadding.top`; composer by the larger of bottom system inset and IME inset, animating with the keyboard (Scaffold `resizeToAvoidBottomInset` lays out but does not sync animation).
- Bottom floating pill tabs: keep hit areas above `systemGestureInsets.bottom`.
- In landscape each of three panes pads only its outer edges.

**Gaps.** Flutter-native IME animation sync APIs; gesture inset dp values.

## 3. Touch targets, typography, font scale, contrast

**Takeaway.** Minimum target 48 dp (secondary source only); text in sp, scaled non-linearly up to 200% from Android 14; test the whole UI at 200%.

**Findings**
- Non-linear scaling to 200% (14sp -> 26sp, 30sp -> 38sp); dp text does not scale. Flutter: test at max, use `TextScaler` (`textScaleFactor` deprecated) ([Flutter](https://docs.flutter.dev/release/breaking-changes/android-14-nonlinear-text-scaling-migration), [migration](https://startdebugging.net/2026/11/migrate-a-flutter-app-from-textscalefactor-to-textscaler/), [FontScaleConverter](https://developer.android.com/reference/android/content/res/FontScaleConverter)).
- Bottom-sheet drag handle: keep >=48 dp at the sheet top (unofficial mirror: [Material Components](https://super12138.github.io/material-components-android/components/BottomSheet.html)). Flutter handle colour: `onSurfaceVariant` at 0.4 ([source](https://codebrowser.dev/flutter/flutter/packages/flutter/lib/src/material/bottom_sheet.dart.html)).
- Use cues beyond colour ([a11y principles](https://developer.android.com/guide/topics/ui/accessibility/principles)). `elegantTextHeight` default true at targetSdk 35, ignored at 36.

**Inferences.** At 200% a header with back, title, context meter and mode overflows: truncate title, move mode to overflow, let the header grow vertically, never clip. Monospace code at 200%: wrap toggle or horizontal scroll; never fix code font in px/dp.

**Gaps (unsourced; verify before quoting).** 48x48 dp with ~8 dp spacing; WCAG 4.5:1 body, 3:1 large text/UI; M3 type scale (body large 16/24, medium 14/20); line length 45-75 chars; M3 dark theme surfaces and contrast levels.

## 4. Gestures, haptics, motion, feedback components

**Takeaway.** Gesture-only interactions need alternatives (custom accessibility actions); long press must be labelled; use platform haptic constants. Official M3 pages on snackbar/dialog/sheet/motion were not retrievable.

**Findings** ([a11y principles](https://developer.android.com/guide/topics/ui/accessibility/principles) unless noted)
- Swipe/drag-only actions need custom actions for TalkBack, Voice Access, Switch Access.
- TalkBack's default "Double tap and hold to long press" is unhelpful: set `onLongClickLabel` (e.g. "Open context menu"); pair with `HapticFeedbackType.LongPress`.
- Sheets/panes need an accessibility pane title, unique across the app.
- Bottom sheet swipe areas must stay away from edges ([edge-to-edge](https://developer.android.com/develop/ui/views/layout/edge-to-edge)). Standard vs modal sheets: secondary only ([m3e](https://matraic.github.io/m3e/components/bottom-sheet.html)). M1 gesture education exists ([M1](https://m1.material.io/growth-communications/gesture-education.html), not read).

**Inferences**
- Hold-to-record with slide cancel/lock is drag-only: needs tap start/stop with explicit Cancel/Send, an accessibility custom action, and semantics announcing recording/locked/canceled.
- Slide paths near the left edge can collide with edge back: keep them inside the composer away from the edge or require pointer capture.
- Haptics at threshold crossings (lock, cancel), not on streaming updates.

**Gaps.** Official M3 rules on snackbar/toast/banner, dialog sizes, sheet max width (640 dp commonly cited, unverified), haptics, Expressive motion tokens; reduced-motion (Android "Remove animations" = animator scale 0; Flutter `MediaQuery.disableAnimations`).

## 5. Accessibility: TalkBack semantics, live regions, focus order

**Takeaway.** Label every control, merge groups, mark headings and pane titles, expose gesture actions. For streaming text use Flutter's `liveRegion`; `SemanticsService.announce` is deprecated on Android because it flushes TalkBack's queue.

**Findings**
- Unique labels per collection item; merge descendants for a group (a message bubble) and keep only the parent interactive; mark headings; hide decorative elements ([a11y principles](https://developer.android.com/guide/topics/ui/accessibility/principles)).
- `SemanticsService.announce` deprecated on Android; prefer Semantics to trigger announcements; `sendAnnouncement` exists, default polite ([announce](https://api.flutter.dev/flutter/semantics/SemanticsService/announce.html), [sendAnnouncement](https://api.flutter.dev/flutter/semantics/SemanticsService/sendAnnouncement.html)).
- `Semantics(liveRegion: true)` is announced politely; behaviour varies by screen reader (Samsung TalkBack) and language ([liveRegion](https://api.flutter.dev/flutter/semantics/SemanticsProperties/liveRegion.html), [DEV guide](https://dev.to/gdg/a-practical-guide-to-flutter-accessibility-part-1-the-basics-4bf1)). Unverified third-party claim: rapid announcements can be dropped.

**Inferences.** Do not make the streaming message a per-token live region: update a summary live node at sentence/completion boundaries ("Agent is responding", "Response complete"), keep full text as a normal node. Tabs need selected-state semantics and announce the new pane title; swipe has tap equivalents (it does). Context meter as text ("62% of context used"), not colour.

**Gaps.** Real TalkBack behaviour under frequent live updates needs device testing; contrast numbers and focus-order rules not fetched.

## 6. Notifications and background work for a client waiting on a long agent turn

**Takeaway.** One channel per event type; a progress-centric Live Update (Android 16) is possible but Google's criteria exclude chat messages; `dataSync` foreground services are capped at 6 h per 24 h on targetSdk 35+.

**Findings**
- Channels (Android 8+): importance is fixed after creation (user controls it), levels NONE(0)-HIGH(4); link to settings via `ACTION_CHANNEL_NOTIFICATION_SETTINGS`; per-conversation-group channels are an explicit example ([channels](https://developer.android.com/develop/ui/views/notifications/channels)).
- Live Updates (Android 16) require: standard/BigText/Call/Progress/Metric style, non-runtime `POST_PROMOTED_NOTIFICATIONS`, `setRequestPromotedOngoing`, ongoing, contentTitle, no custom RemoteViews, not a group summary, not colorized, channel not IMPORTANCE_MIN. Criteria: ongoing, user-initiated, time-sensitive; chat messages, alerts, promotions are inappropriate; ETA-less states use active placeholder text ("Thinking..."); status chip max 96 dp; do not repost dismissed ones (`setDeleteIntent`); `canPostPromotedNotifications()`; OEMs may add criteria ([Live updates](https://developer.android.com/develop/ui/views/notifications/live-update)).
- FGS timeout: `dataSync` and `mediaProcessing` run 6 h total per 24 h; then `onTimeout()` and `stopSelf()` within seconds or a crash; foregrounding the app resets the timer; starting another throws `ForegroundServiceStartNotAllowedException`; start only from direct user interaction or use WorkManager ([FGS timeout](https://developer.android.com/develop/background-work/services/fgs/timeout)).
- Android 16: `scheduleAtFixedRate` runs at most one missed execution on return to a valid lifecycle (targetSdk 36).

**Inferences.** Prefer FCM/push (or the relay) for "turn finished / needs approval" over a held foreground service; if a socket must stay alive during an active turn, a user-initiated FGS fits the 6 h window. Channels: "approval needed" HIGH, "turn finished" DEFAULT, "turn in progress" LOW. A Live Update for a running turn is a grey area; treat as optional, with a plain ongoing notification fallback.

**Gaps.** `POST_NOTIFICATIONS` runtime permission and Android 16 cooldown/grouping; Flutter plugin support for `ProgressStyle`/promoted ongoing.

## 7. Flutter-specific availability

**Takeaway.** Official Flutter has no first-party Material 3 Expressive as of Nov 2026; work moves to decoupled packages (material_ui). Predictive back and edge-to-edge are native.

**Findings**
- [flutter#168813](https://github.com/flutter/flutter/issues/168813): May 2025 not actively developing Expressive; July 2025 Material/Cupertino being decoupled, new Expressive work only in packages; 30 Jun 2026 team committed to both design systems; 17 Aug 2026 flutter/packages PR #12093 shows decoupled Expressive work in progress; no release date. Planned scope: app bars, button groups, carousel, buttons, extended FAB, FAB menu, icon buttons, loading indicator, nav bar/rail, progress indicators, split button, toolbars, motion physics, 35 shapes, expressive typography.
- Third-party packages: `material_3_expressive` (1.0.0 on 2026-04-17; 1.0.8 needs material_ui ^1.0.0 and Flutter >= 3.44.0), `m3e_core`, `m3e_floating_toolbar`, `m3_expressive`; whether `material_ui` is official was NOT confirmed ([pub.dev](https://pub.dev/packages/material_3_expressive), [floating toolbar](https://pub.dev/packages/m3e_floating_toolbar)). Compose has Expressive components ([Compose M3E](https://composables.com/material-3-expressive)).
- Predictive back, edge-to-edge, `liveRegion`, `sendAnnouncement`, `TextScaler`: see sections 1-3 and 5.

**Inferences.** Pill header/tabs are custom anyway: build with core Flutter (`Material` + shapes), keep an Expressive swap-in boundary, avoid a third-party Expressive package for core navigation until material_ui stabilises. Adaptive layout: no Jetpack WindowSizeClass in Flutter; use `MediaQuery.sizeOf(context)` (window, not device) with 600/840 dp breakpoints plus a height check; foldable posture needs `dual_screen` or a platform channel (not researched).

**Gaps.** Whether `material_ui` is the official package and its status; the project's Flutter version; foldable hinge support.
