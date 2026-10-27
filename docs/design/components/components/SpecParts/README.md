# SpecParts

SpecParts are the drawing parts on the design canvas page "需求 · 界面零件" (https://claude.ai/artifact/2GtB5izXeQSV3NecUYuLAo). They are used to illustrate the spec boards: Term, Frame, Web, Menu, Dialog, Note, Panel, Top, Arrow, Cursor and Callout. They are pictures at about 75% scale, not product components.

| Part | Draws | Real component |
| --- | --- | --- |
| Term | terminal window: lamp, name, label, status, lines, exit bar | WindowShell + TerminalWindow |
| Frame | workspace frame: default, selected, drop, highlighted, empty | WorkspaceFrame |
| Web | browser window: login, JSON, not responding | BrowserWindow |
| Menu | context menu with an active row and separators | Menu, ContextMenus |
| Dialog | title, fields, radio text, button row | Dialog, Field |
| Note | toast, popover, notification, folder chip, key cap | Toast, Popover |
| Panel | source control panel | ScmPanel |
| Top | top bar with counts | Topbar |
| Arrow | flow arrow with a label ("单击") | spec only |
| Cursor | pointer, optional click ring | spec only |
| Callout | numbered ink disc | spec only |

**Rules for spec drawings**
- Use them to explain flows; build product UI from the real components.
- The parts predate MVP v2. Term and Top draw waiting in orange #C2410C and running with an ink dot; Frame uses radius 8 instead of `radius-frame` 12. When you draw a new board, follow StatusLamp: green running, yellow waiting dot with `attention` words, red error.
- Arrow, Cursor and Callout are ink on the canvas ground, and Callout numbers mark steps in a flow.
