# Icons

Icons are the inline line icons copied from the components. They are SVG with `stroke="currentColor"`, so they take the text colour: `muted` at rest, `ink` on hover, `on-ink` on a pressed button.

**Sources**
- `window-shell/src/WindowShell.tsx`: Maximize, Restore, Close (12px, stroke 1.3).
- `topbar/src/Topbar.tsx`: Chevron, Settings gear (15px), History sidebar toggle (14px).
- `kit/src/Menu.tsx`: menu check and submenu arrow.
- `canvas/src/react/FrameNodeView.tsx`: Tidy, Columns, Rows, Auto-arrange (14px).
- `panels/scm/src/icons.tsx`: Branch, Refresh, Stage, Unstage, Discard, Back, Disclosure, Caret, Check (14px on a 16 grid, stroke 1.4).
- `panels/manager/src/ManagerPanel.tsx`: Window and Folder (10px), Plus and Search (12px), Pin (9px).

**Rules**
- Draw new icons the same way: 12–15px, `fill="none"`, stroke 1.3–1.4, round caps and joins, `aria-hidden="true"`. Give the button an `aria-label`.
- No icon fonts, raster icons or emoji.
- Status is never an icon; use StatusLamp.
