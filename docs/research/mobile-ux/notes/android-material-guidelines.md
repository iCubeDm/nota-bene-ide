# Android and Material Design 3 (Expressive) guidelines for a content-heavy chat-and-documents Flutter app (state as of Nov 2026)

Research note. Sourcing caveat: m3.material.io pages are JS-rendered and returned no content via fetch (tabs, toolbars); M3 specifics therefore rely on developer.android.com, Flutter docs/issues and secondary sources, and are flagged. Items I could not source are in Gaps, not in findings.

## 1. Navigation: tabs vs swipeable panes, predictive back, app bars, floating toolbar, adaptive layouts

### Takeaway
Material has long allowed switching tabs by tap or by swiping over the content, but warns against pairing tab-swipe with content that has its own horizontal swipe (maps, swipeable list items). On Android 16 (targetSdk 36) predictive back is on by default and the app must handle back through the supported APIs (Flutter: PopScope plus the manifest flag). Window size classes: compact <600, medium 600-839, expanded 840-1199 dp; your 840 dp three-pane threshold equals the official "expanded" breakpoint.

### Cited Findings
- Tabs can be switched by tapping a tab or swiping left/right over the content area, including for fixed tabs (M2 tabs guidance; M3 page not retrievable) — [M2 tabs](https://m2.material.io/go/design-tabs)
- Material warns against pairing tabs with content that also supports swiping, and says to use caution with other swipeable content such as interactive maps or list items in the content area — [M1 tabs](https://m1.material.io:443/components/tabs.html), [M2 tabs](https://m2.material.io/go/design-tabs)
- Android's official swipe-view implementation is ViewPager2 + tab layout; design guidance is deferred to Material tabs docs — [Android swipe views](https://developer.android.com/guide/navigation/navigation-swipe-view-2)
- System gesture insets: on Android 10+ they contain a bottom inset for the home gesture and left/right insets for back gestures. Google says to use them "to move or pad swipeable views away from the edges"; named use cases: bottom sheets, carousels, and ViewPager2 — [Edge-to-edge (Views)](https://developer.android.com/develop/ui/views/layout/edge-to-edge)
- Design guidance for gesture navigation: support edge-to-edge and "avoid adding interactions or touch targets under gesture navigation insets" — [System bars design](https://developer.android.com/design/ui/mobile/guides/foundations/system-bars)
- Predictive back (Android 16): for apps targeting API 36 on Android 16+, system back animations (back-to-home, cross-task, cross-activity) are enabled by default; `onBackPressed` is not called and `KEYCODE_BACK` is not dispatched. Opt-out: `android:enableOnBackInvokedCallback="false"` on `<application>`/`<activity>` — [Android 16 behavior changes](https://developer.android.com/about/versions/16/behavior-changes-16)
- Android guide: on Android 16+, a callback with PRIORITY_DEFAULT/PRIORITY_OVERLAY (OnBackPressedCallback/OnBackInvokedCallback) suppresses the predictive animations and the app must handle back itself; PRIORITY_SYSTEM_NAVIGATION_OBSERVER observes without consuming — [Predictive back guide](https://developer.android.com/guide/navigation/predictive-back-gesture) (via search summary, not full fetch)
- Flutter: predictive back animations are enabled by default from Android 14 for system gestures when the app supports them; set `android:enableOnBackInvokedCallback="true"` on `<application>` (Android 13+); use `PopScope` (with `onPopInvokedWithResult`) — it replaces deprecated `WillPopScope`; `canPop:false` intercepts back — [Flutter predictive back](https://docs.flutter.dev/platform-integration/android/predictive-back.md)
- Flutter registers `PredictiveBackPageTransitionsBuilder` in `PageTransitionsTheme` for `TargetPlatform.android` to get the page-route predictive animation — [Flutter predictive back (search summary)](https://docs.flutter.dev/platform-integration/android/predictive-back.md), [breaking change](https://docs.flutter.dev/release/breaking-changes/android-predictive-back)
- Window size classes (width): compact <600 dp; medium 600 <= w <840; expanded 840 <= w <1200; large 1200 <= w <1600; extra-large >=1600. Height: compact <480; medium 480-<900; expanded >=900. Large/XL were added beyond the M3 compact/medium/expanded set — [Window size classes](https://developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes)
- Phones in landscape are typically compact height (99.78% of phones in landscape <480 dp height) and window width often medium; Google notes two-pane layouts are not practical when height is compact — [Window size classes](https://developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes)
- Decide layout from window size (WindowManager metrics), not device type; window size class can change at runtime (rotation, split screen, fold/unfold, desktop windowing); do not use isTablet logic — [Window size classes](https://developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes), [Support different display sizes](https://developer.android.com/develop/ui/compose/layouts/adaptive/support-different-display-sizes)
- Adaptive state hygiene: pass all data to composables regardless of size and hoist state (e.g. selected pane) so it survives layout switches from resize/fold — [Support different display sizes](https://developer.android.com/develop/ui/compose/layouts/adaptive/support-different-display-sizes)
- Android 16 (targetSdk 36): orientation, resizability and aspect-ratio restrictions are ignored on displays with smallest width >= 600 dp (no letterboxing); exceptions: games, user opt-in, sw < 600 dp; opt-out property is temporary and not honoured for targetSdk 37 — [Android 16 behavior changes](https://developer.android.com/about/versions/16/behavior-changes-16)
- Play requires new apps/updates to target API 36 from 2026-08-31 (official table); apps therefore get edge-to-edge forced and predictive back default — [Play target API](https://developer.android.com/google/play/requirements/target-sdk)
- Adaptive navigation: switch navigation bar/rail by window size class; canonical layouts (list-detail, supporting pane) are the recommended large-screen patterns — [System bars design](https://developer.android.com/design/ui/mobile/guides/foundations/system-bars)
- M3 Expressive "toolbars": floating toolbar = page-specific actions in a flexible undocked layout, with a vertical variant; M3E also adds button groups (standard/connected, touched button grows and neighbours shrink), FAB menu, split button, loading indicator — secondary sources only: [9to5Google](https://9to5google.com/2025/05/18/material-3-expressive-toolbars/), [Compose M3E overview](https://composables.com/material-3-expressive), [Flutter issue #168813 component list](https://github.com/flutter/flutter/issues/168813)
- A floating pill header/tabs are not an official M3 app-bar pattern; closest official parts are Expressive floating toolbar (actions) and docked toolbar; no official guidance found on pill-shaped floating *navigation* tabs — absence noted, see Gaps.

### Inferences
- Swiping a PageView across Files/Chat/Comments conflicts with: (a) the edge back gesture (starts at left/right screen edge; first page's rightward swipe and last page's leftward swipe near edges collide), (b) horizontal scrolling in code/diff/table viewers, (c) text selection handles. Material's own caution supports restricting swipe or giving viewers priority.
- Mitigations: keep tabs tappable as primary; disable page-swipe while a child horizontal scrollable can scroll (use nested `NotificationListener`/`ScrollPhysics` hand-off or only enable swipe from the pill/header strip or when child is at scroll extent); inset swipe-sensitive regions by the system gesture insets (Flutter: `MediaQuery.systemGestureInsets`); a sheet/viewer opened over the page should be on top of the back stack and use `PopScope` so predictive back animates it.
- Three panes at >=840 dp matches "expanded"; but use height class too: a phone in landscape (<480 dp height, width ~800-900) is medium/expanded width yet compact height, so choose panes by width AND minimum usable height, and the pill tabs make sense only where panes are collapsed.
- With targetSdk 36 on tablets (sw>=600) the app cannot lock orientation; the layout must survive rotation and window resize with preserved state (composer draft, scroll positions, recording state).

### Gaps
- Official M3 text on tab swiping, floating toolbar specs (heights, padding, behaviour), and button-group dimensions: m3.material.io not retrievable.
- No official statement found on when swiping between top-level panes is "discouraged" beyond the older Material caution above.
- Back-gesture edge zone width in dp is device/OEM-specific; no number found.

## 2. Edge-to-edge, insets, IME, cutouts

### Takeaway
Edge-to-edge is forced for targetSdk >=35 and the opt-out is removed for targetSdk 36 on Android 16; Flutter 3.27+ targets 35 by default and defaults to `SystemUiMode.edgeToEdge`. Handle system-bar, cutout and IME insets explicitly; keep the gesture nav bar transparent.

### Cited Findings
- Targeting SDK 35+ on Android 15+ draws the app edge-to-edge behind status, caption and navigation bars; `windowOptOutEdgeToEdgeEnforcement` is deprecated and disabled for targetSdk 36 on Android 16 (still works on Android 15 devices) — [Edge-to-edge](https://developer.android.com/develop/ui/views/layout/edge-to-edge), [Android 16 behavior changes](https://developer.android.com/about/versions/16/behavior-changes-16)
- Inset types for edge-to-edge: system bars, display cutout, system gestures. Apps draw into the cutout by default, so pad lists/controls with `systemBars | displayCutout`; use `clipToPadding=false` so content scrolls behind bars — [Edge-to-edge](https://developer.android.com/develop/ui/views/layout/edge-to-edge)
- Defaults with enforcement: transparent status bar and gesture nav bar; 3-button nav bar gets a translucent scrim (remove with `Window.setNavigationBarContrastEnforced(false)`). Google: always keep gesture nav bar transparent (don't add a background); use transparent 3-button bar when a bottom bar/non-scrolling UI sits there, translucent when scrolling content goes under — [System bars design](https://developer.android.com/design/ui/mobile/guides/foundations/system-bars), [Edge-to-edge](https://developer.android.com/develop/ui/views/layout/edge-to-edge)
- Use gradient/solid protection behind status bar when content scrolls under it; protection colour should match the pane's background; list-detail may need different protections per pane — [Edge-to-edge](https://developer.android.com/develop/ui/views/layout/edge-to-edge)
- Keyboard: each navigation type reacts to the on-screen keyboard; use `WindowInsetsAnimationCompat` to synchronise app transitions with the keyboard sliding — [System bars design](https://developer.android.com/design/ui/mobile/guides/foundations/system-bars)
- Full-screen dialogs must be made edge-to-edge too (`enableEdgeToEdge` on the dialog window) — [Edge-to-edge](https://developer.android.com/develop/ui/views/layout/edge-to-edge)
- Edge-to-edge in desktop windowing: a system caption bar is always visible at top; use `systemBars()`/`captionBar()` insets — [Edge-to-edge](https://developer.android.com/develop/ui/views/layout/edge-to-edge)
- Flutter: apps using the default `flutter.targetSdkVersion` target Android 15 from Flutter 3.27 and are opted into edge-to-edge; `SystemUiMode.edgeToEdge` is the default and other modes don't work without migration; opt-out only works on Android 15 — [Flutter breaking change](https://docs.flutter.dev/release/breaking-changes/default-systemuimode-edge-to-edge)
- Reported Flutter pitfall after targeting 35: Scaffold body drawing under nav bar; fix via SafeArea/MediaQuery padding rather than opt-out (third-party) — [startdebugging.net](https://startdebugging.net/ru/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/)

### Inferences
- A floating pill header must be offset by `MediaQuery.viewPadding.top` (status bar + cutout); the composer by bottom system inset OR IME inset, whichever is larger (`viewInsets.bottom` vs `viewPadding.bottom`), and must animate with the keyboard (Flutter `Scaffold` resizeToAvoidBottomInset handles layout but not a synced animation).
- Floating pill tabs near the bottom sit near the home-gesture inset: keep their hit areas above `systemGestureInsets.bottom`.
- In landscape, left/right cutout and nav-bar insets apply per pane; each of the three panes should pad only its outer edges.

### Gaps
- Exact IME/animation APIs available natively in Flutter (no official note found on WindowInsetsAnimation sync).
- Gesture inset dp values not found.

## 3. Touch targets, spacing, typography, font scale, themes and contrast

### Takeaway
Minimum touch target is 48 dp (sourced only secondarily this session); text must use sp and is scaled non-linearly up to 200% from Android 14; test the whole UI at 200%.

### Cited Findings
- Android 14 introduced non-linear font scaling up to 200%: large text scales less than small text (example: 14sp -> 26sp, 30sp -> 38sp at 200%); dp-sized text does not scale; Flutter says test at the maximum (200%) font size and use `TextScaler` (textScaleFactor deprecated) — [Flutter Android 14 nonlinear scaling](https://docs.flutter.dev/release/breaking-changes/android-14-nonlinear-text-scaling-migration), [textScaleFactor to TextScaler](https://startdebugging.net/2026/11/migrate-a-flutter-app-from-textscalefactor-to-textscaler/), [FontScaleConverter](https://developer.android.com/reference/android/content/res/FontScaleConverter)
- Bottom-sheet drag handle: Material Components docs say keep at least 48 dp at the top of the sheet for the handle to meet touch-target minimum (unofficial mirror; verify) — [mirror of Material Components Android docs](https://super12138.github.io/material-components-android/components/BottomSheet.html)
- Flutter drag handle default colour: `onSurfaceVariant` at 0.4 opacity — [Flutter bottom_sheet.dart](https://codebrowser.dev/flutter/flutter/packages/flutter/lib/src/material/bottom_sheet.dart.html)
- Use cues other than colour (shape, text, haptics) to distinguish elements — [Android accessibility principles](https://developer.android.com/guide/topics/ui/accessibility/principles)
- Android 15 `elegantTextHeight` default true for targetSdk 35 and ignored at 36 (taller line metrics for some scripts) — [Android 16 behavior changes](https://developer.android.com/about/versions/16/behavior-changes-16)

### Inferences
- With a pill header holding back, title, context meter and mode at 200% font, labels will overflow: truncate title, move mode into overflow, allow header to grow vertically, never clip.
- Monospaced code at 200% scale: allow wrapping toggle or horizontal scroll; do not fix code font in px/dp.

### Gaps (unsourced this session; commonly cited values, verify before quoting)
- 48x48 dp minimum target with ~8 dp spacing (Android/M3 accessibility); WCAG contrast 4.5:1 body text and 3:1 large text/UI components; M3 type scale values (body large 16/24, body medium 14/20); readable line length (~45-75 characters; M3 gives no hard number found); M3 dark theme surface colours/contrast levels (standard/medium/high). None fetched successfully.

## 4. Gestures, haptics, motion, feedback components

### Takeaway
Gesture-only interactions need an alternative (custom accessibility actions); long-press must be labeled; haptic calls use the platform constants. Official M3 pages on snackbar/dialog/sheet/motion were not retrievable.

### Cited Findings
- Any swipe/drag-only action should be exposed as accessibility custom actions for TalkBack, Voice Access, Switch Access — [Android accessibility principles](https://developer.android.com/guide/topics/ui/accessibility/principles)
- Long-press: TalkBack's default "Double tap and hold to long press" is unhelpful; set `onLongClickLabel` (e.g. "Open context menu"); example pairs long-press with `HapticFeedbackType.LongPress` — [Android accessibility principles](https://developer.android.com/guide/topics/ui/accessibility/principles)
- Material gesture-education guidance exists (M1) — [M1 gesture education](https://m1.material.io/growth-communications/gesture-education.html) (not read)
- Bottom sheets: Android says system gesture insets matter for bottom sheets (keep swipe areas away from edges) — [Edge-to-edge](https://developer.android.com/develop/ui/views/layout/edge-to-edge)
- Bottom sheet types: standard (coexists with UI) vs modal (blocks UI, dialog-like) — secondary only: [m3e docs](https://matraic.github.io/m3e/components/bottom-sheet.html)
- Give bottom sheets/panes an accessibility pane title; titles must be unique across the app or TalkBack can behave unpredictably — [Android accessibility principles](https://developer.android.com/guide/topics/ui/accessibility/principles)

### Inferences
- Hold-to-record mic with slide-cancel/lock is a drag-only gesture: needs a non-gesture alternative (tap to start/stop recording, explicit Cancel/Send buttons) and an accessibility custom action; announce state changes (recording, locked, canceled) via semantics.
- Slide-to-cancel/lock horizontal and vertical drags near screen edges may collide with edge-back; keep the slide path inside the composer area away from the left edge, or require pointer capture.
- Haptics: use on gesture threshold crossings (lock, cancel), not on streaming updates.

### Gaps
- Official M3 rules: snackbar vs toast vs banner, dialog sizes, sheet max width (640 dp in M3 is commonly cited; unverified), haptics guidance, motion tokens/spring specs for Expressive. Not retrieved.
- Reduced-motion: no official source fetched (Android "Remove animations" setting maps to animator duration scale 0; Flutter `MediaQuery.disableAnimations`).

## 5. Accessibility: TalkBack semantics, live regions, focus order, reduced motion

### Takeaway
Label every control, merge related groups, mark headings and pane titles, and expose gesture actions. For streaming text Flutter's `liveRegion` is the supported path; `SemanticsService.announce` is deprecated on Android because it flushes TalkBack's queue.

### Cited Findings
- Labels must be unique per collection item (`collectionInfo`/`collectionItemInfo`); merge descendants for a group (e.g. a message bubble) and make only the parent interactive; mark headings; decorative elements get null content description/hidden — [Android accessibility principles](https://developer.android.com/guide/topics/ui/accessibility/principles)
- Flutter: `SemanticsService.announce` is deprecated for Android (announcement events force TalkBack to clear its speech queue); recommended: use Semantics to trigger announcements implicitly; `sendAnnouncement(view, message, textDirection, assertiveness)` exists, default polite — [SemanticsService.announce](https://api.flutter.dev/flutter/semantics/SemanticsService/announce.html), [sendAnnouncement](https://api.flutter.dev/flutter/semantics/SemanticsService/sendAnnouncement.html)
- `Semantics(liveRegion: true)` marks a node whose updates the platform may announce politely; community guide uses it for changing text, noting behaviour varies by screen reader (Samsung TalkBack) and language — [liveRegion](https://api.flutter.dev/flutter/semantics/SemanticsProperties/liveRegion.html), [DEV guide](https://dev.to/gdg/a-practical-guide-to-flutter-accessibility-part-1-the-basics-4bf1)
- Third-party claim (unverified): rapid announcements can be dropped — [wrapper docs](https://meander-eircodex.pages.dev/component/live-region-announcer.html)

### Inferences
- Do not mark the whole streaming message as a live region updating per token; instead update an off-screen/summary live node at sentence or completion boundaries ("Agent is responding", "Response complete"); keep full text reachable as a normal node.
- Tabs Files/Chat/Comments need selected-state semantics and the pane change should announce the new pane title; PageView swipe must have tap equivalents (it does).
- Context meter: expose as a value with text ("62% of context used"), not colour alone.

### Gaps
- Real TalkBack behaviour with frequent live-region updates: needs device testing; no authoritative source.
- Contrast numbers and focus-order rules not fetched this session.

## 6. Notifications and background work for a client waiting on a long agent turn

### Takeaway
Use a user-visible channel per event type; for an in-progress agent turn consider a progress-centric Live Update (Android 16) but note Google's criteria exclude chat messages; foreground services of type `dataSync` are capped at 6 h per 24 h on targetSdk 35+.

### Cited Findings
- All notifications need a channel (Android 8+); importance cannot be changed after creation (user has control); importance levels NONE(0) to HIGH(4); offer a link to channel settings via `ACTION_CHANNEL_NOTIFICATION_SETTINGS`; separate channels per conversation group are an explicit example — [Notification channels](https://developer.android.com/develop/ui/views/notifications/channels)
- Live Updates (Android 16): requirements: standard/BigText/Call/Progress/Metric style; manifest permission `POST_PROMOTED_NOTIFICATIONS` (non-runtime); request promotion (`setRequestPromotedOngoing`); must be ongoing; contentTitle set; no custom RemoteViews; not a group summary; not colorized; channel not IMPORTANCE_MIN — [Live updates](https://developer.android.com/develop/ui/views/notifications/live-update)
- Usage criteria: ongoing, user-initiated, time-sensitive; inappropriate uses include chat messages, alerts, promotions; show ETA-less states with active placeholder text ("Thinking..."); status chip max width 96 dp (text shown only if it fits; <7 chars show all); don't repost dismissed Live Updates (use `setDeleteIntent`); `NotificationManager.canPostPromotedNotifications()` and `ACTION_MANAGE_APP_PROMOTED_NOTIFICATIONS` for settings; OEMs may add criteria — [Live updates](https://developer.android.com/develop/ui/views/notifications/live-update)
- Foreground-service timeout (targetSdk 15+): `dataSync` and `mediaProcessing` FGS may run 6 h total per 24 h (tracked separately); system then calls `Service.onTimeout()` and the service must `stopSelf()` within seconds or the app crashes (RemoteServiceException); bringing the app to the foreground resets the timer; starting another after exhaustion throws `ForegroundServiceStartNotAllowedException`; suggestion: start only from direct user interaction or use WorkManager/alternatives — [FGS timeout](https://developer.android.com/develop/background-work/services/fgs/timeout)
- Android 16: `scheduleAtFixedRate` runs at most one missed execution when the app returns to a valid lifecycle (targetSdk 36) — [Android 16 behavior changes](https://developer.android.com/about/versions/16/behavior-changes-16)

### Inferences
- Client waiting on a server-side agent: prefer FCM/push (or the relay) to notify "turn finished / needs approval" over holding a foreground service; if a socket must stay alive during an active turn, a user-initiated FGS (started from foreground) fits the 6 h window; give an "approval needed" channel at HIGH and "turn finished" at DEFAULT, "turn in progress" at LOW.
- A progress-centric Live Update for a running turn is arguably "ongoing, user-initiated, time-sensitive" but is a grey area (not navigation/delivery-style); OEM criteria vary; treat as optional enhancement with a plain ongoing notification fallback.

### Gaps
- POST_NOTIFICATIONS runtime permission (Android 13) and Android 16 notification cooldown/grouping details not fetched; Flutter plugin support for `ProgressStyle`/promoted ongoing not researched.

## 7. Flutter-specific availability

### Takeaway
As of Nov 2026 official Flutter has no first-party Material 3 Expressive; work is moving to decoupled packages (material_ui). Predictive back and edge-to-edge are supported natively.

### Cited Findings
- Flutter issue #168813 (Expressive): May 2025 team not actively developing Expressive; July 2025 Material/Cupertino being decoupled into packages, new Expressive work only there; Aug 17 2026 a contributor linked flutter/packages PR #12093 showing decoupled Expressive work in progress and the issue moved to the package label; June 30 2026 team said Flutter remains committed to both design systems; no release date/version given — [Flutter #168813](https://github.com/flutter/flutter/issues/168813)
- Planned Expressive component list (scope reference only): app bars, button groups (new), carousel, buttons, extended FAB, FAB menu (new), FABs, icon buttons, loading indicator (new), nav bar, nav rail, progress indicators, split button (new), toolbars (new); plus motion-physics, 35 new shapes, expressive typography — [Flutter #168813](https://github.com/flutter/flutter/issues/168813)
- Third-party: `material_3_expressive` (1.0.0 on 2026-04-17; 1.0.8 requires material_ui ^1.0.0 and Flutter >= 3.44.0), `m3e_core`, `m3e_floating_toolbar`, `m3_expressive` on pub.dev; an official-vs-unofficial status of `material_ui` was NOT confirmed — [search results](https://pub.dev/packages/material_3_expressive), [m3e_floating_toolbar](https://pub.dev/packages/m3e_floating_toolbar)
- Compose has Expressive components (FloatingToolbar, ButtonGroup, FAB menu) — [Compose M3E](https://composables.com/material-3-expressive), [FloatingToolbarDefaults](https://composables.com/jetpack-compose/androidx.compose.material3/material3/objects/FloatingToolbarDefaults/api.md)
- Predictive back: manifest flag + `PredictiveBackPageTransitionsBuilder` + `PopScope`; edge-to-edge: default `SystemUiMode.edgeToEdge` since Flutter 3.27 — see sections 1 and 2.
- Accessibility: `Semantics(liveRegion)`, `SemanticsService.sendAnnouncement`; Android 14 non-linear scaling via `TextScaler` — see sections 3 and 5.

### Inferences
- Pill header/tabs are custom anyway: build them with core Flutter (Material 3 `Material` + shapes) and keep an Expressive swap-in boundary; avoid depending on a third-party Expressive package for core navigation until material_ui stabilises.
- Adaptive layout in Flutter: no Jetpack WindowSizeClass; use `MediaQuery.sizeOf(context).width` (window, not device) with the 600/840 dp breakpoints, plus height check; foldable posture requires `dual_screen`/platform channel (not researched).

### Gaps
- Confirmation that `material_ui` is the official Flutter package and its release status; Flutter version in use at project; foldable hinge/posture support in Flutter not researched.
