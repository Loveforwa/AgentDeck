# BrowserWindow

BrowserWindow is a web page on the board: a toolbar (Back, Forward, Reload, a mono address field, Open in browser) over an iframe for localhost or a webview for external sites.

**Code:** `packages/ui/widgets/browser/src/BrowserWindow.tsx`, `browser.css`, registered as `type: 'browser'`. The title bar shows the host name. ⌘T opens a new one; the MCP tool `open_browser` reuses one per origin (`reuseKey`).

**Tokens:** toolbar `control-sm` + `space-sm` high, `line-subtle` bottom border; ghost icon buttons `muted` → `ink`; address `ground` fill, `radius-inset`, mono `text-xs`, `line` border on hover and `focus` border when editing; content `ground`; messages centred, title `text-md`, detail `muted`.

**States**
- **Loading** and **loaded**.
- **Not responding:** "localhost:3000 isn’t responding." with "The dev server may not have started yet, or it stopped." and Retry.
- **Address error:** a hint row under the toolbar.
- **Unfocused:** a shield covers the page. The first click only focuses; for 600ms the wheel and clicks pass through to the page.

**Interaction:** dragging a browser window into another frame moves it there directly; it has no pinned workspace. ⌘[ goes back.
