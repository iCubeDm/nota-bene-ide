# Phone: zoom while marking up (issue 377)

Small change. Marking up a picture on the phone reset the zoom and took every gesture for drawing, so small marks were
hard to place. Agreed with the user: while marking, one finger draws and two fingers zoom and pan; entering markup keeps
the current zoom; the same for a video frame.

Approaches: a raw pointer listener that hands two-finger gestures to the zoom (chosen: deterministic, the drawing
recognizer keeps one finger) versus an `InteractiveViewer` competing with the drawing recognizer in the gesture arena
(a one-finger draw and a two-finger pinch race for the same pointers).

Design: `MarkupZoom` wraps the `MarkupLayer` while marking; a second finger sets `Markup.pinching`, which drops the
shape under way and draws nothing until every finger is up. Scale 1 to 8, the picture always fills the view, the point
under the fingers stays under them. Shapes stay relative to the picture, so the comment format does not change.
