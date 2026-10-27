# LayoutGuides

LayoutGuides is the blue feedback shown only while you arrange the board (MVP v2 · V3 and X10): snap lines, spacing and size labels, the selected-window outline, and the Shift-drag marquee.

**Code:** `packages/ui/canvas/src/react/Guides.tsx` (screen-space SVG), `src/model/snap.ts`, `src/model/avoid.ts`, `src/react/selection.tsx`; styles in `canvas.css` (`.ad-guide-*`) and `selection.css`.

**Tokens:** `guide` for everything here. Lines are 1px, dashed 4 3 for spacing; labels are mono `text-xs` on a `surface` chip with `radius-inset`. The selection outline is 2px offset 2; the marquee is a 1px border over an 8% `guide` wash.

**Rules**
- Guides exist only during a drag or resize and never mean a status.
- Snap within 6 screen px to edges, centre lines, the 20px gap, equal spacing and equal size, and to nearby frames within 200px. Hold ⌘ to stop snapping.
- On release, an overlapping window slides to the nearest free spot 16px away; other windows are never pushed. A maximized window may cover others.
- To select, Shift + drag empty space; anything the box touches is selected (⌘ adds). ⌘ or Shift + click a title bar to toggle. Esc clears.
- A selection moves together; each window stays in its own frame.
