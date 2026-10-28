# Menu

Menu is the data-driven list used for every right-click menu, the project menu and pickers: items, separators, uppercase headings, check marks, hints, shortcuts and submenus.

**Code:** `packages/ui/kit/src/Menu.tsx`, `menu.css`. Menu does not position itself: put it in `Popover chrome={false}`.

**Items:** `{ id, label, shortcut?, checked?, disabled?, hint?, icon?, mono?, items?, onSelect? }`, `{ type: 'separator' }`, `{ type: 'heading', label }`. `checked` set ⇒ a check column; `items` ⇒ submenu with ▸; `hint` is grey text after the label (a disabled item's reason or a quiet tag, also its tooltip); `icon` is a small leading mark drawn by the caller, such as a status lamp (every item of that level then keeps an 8px slot so labels line up); `mono` sets the label in the mono face (terminal names).

**Tokens:** `raised` fill, `line` border, `radius-menu`, `shadow-float`, padding `space-xs`; items `row` 24px, `radius-inset`, active `hover`; separator `line-subtle`; heading `eyebrow` (11px, 600, 0.04em, `muted`); shortcut `text-sm` `muted`; hint `text-xs` `muted`; min width 180.

**Keyboard**
- ↑ ↓ Home End move and skip disabled items and separators. Enter or Space selects.
- → opens a submenu; ← or Esc closes it. Esc on the root calls `onClose`; Tab closes.
- A first letter jumps to the matching item.
- When opened from the keyboard, pass `defaultActive="first"`.

**Rules**
- Sentence-case verbs and … for dialogs. Shortcuts use ⌘⇧ glyphs: ⌘N, ⌘T, ⌘⇧N, ⌘W, ⌘1.
- Plugins appear as a `PLUGINS` heading group, listed flat, never in a submenu; see ContextMenus.
- A greyed item states why in `hint`, for example "Not supported for kimi yet".
