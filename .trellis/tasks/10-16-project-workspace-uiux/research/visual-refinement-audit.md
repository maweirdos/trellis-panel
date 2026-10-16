# Chrome visual audit and correction — 2026-10-16

## Evidence

Current user-provided references, retained locally under
`C:/Users/Maweirdos/.codex/visualizations/2026/10/16/01a1436e-1074-7543-b63b-a091acb889ed/uiux-polish-qa/`:

- `00-codex-reference.png`: Codex benchmark supplied by user.
- `00-user-rejected-native.png`: actual Trellis native window supplied by user.
- `01-before-overview-light.jpg`: current audit-run browser capture, inspected before edits.
- `02-refined-overview-light.jpg`: inspected renderer refinement capture. This preceded the
  last rail scrollbar-gutter alignment adjustment and is direction evidence, not final native QA.

The browser root's HTML/BODY/#root/.my-root border width was zero, outline style none,
radius zero. The native rounded perimeter cannot be attributed to these renderer boxes.
An initial native capture returned the wrong foreground app and was rejected. A later Raise
capture showed Trellis correctly, but no post-native-fix capture was accepted before UI control
was stopped. No third-party page shown by a wrong capture was used as product evidence.

## Steps and findings

1. **Overview header — visual defect.** The project was a small bordered input-like control,
   with several boxed controls and dividers competing with it. Correction: borderless 16px
   title, quiet chevron/hover surface, lightweight command action and simpler alignment.
2. **Fixed rail — visual defect.** 18px icons plus permanent 10px captions looked like a
   compressed mobile toolbar. Correction: 22px desktop icons in 40px targets with stable
   peer order, full accessible names/hover labels and quiet neutral selection. The last
   alignment fix removes the rail's reserved scrollbar gutter, preserving scrolling.
3. **Context navigation — visual defect.** Bordered/shadowed rows read as mini cards.
   Correction: 14px readable rows, 36px height, 224px width (200px narrow), soft selection
   without persistent row borders/shadows. Actual final geometry still needs capture.
4. **Native perimeter — verification incomplete.** Installed Electron supported accent API
   was traced to DWMWA_BORDER_COLOR. The ordinary main window now mirrors existing
   light/dark canvas/border colors at creation and theme patches. No resize/corner/snap
   options, utility-window lifecycle, OS settings or new IPC were changed. Browser captures
   cannot establish that Windows actually rendered the intended perimeter.

## Accessibility and limits

Keyboard focus rules remain on controls, not the entire shell. Icon targets retain complete
accessible names and native title labels. The scoped code checks pass, but screenshot and
keyboard/native behavior do not follow from that alone. The user physically pressed Escape
to stop Computer Use; all further browser/native input was stopped for the turn. Therefore
no final post-fix native focused/unfocused or resize/maximize comparison is claimed.

Root design-qa.md remains blocked until the interrupted visual verification is completed.
No staging, commit or archive occurred. The previous commit plan is marked superseded.
