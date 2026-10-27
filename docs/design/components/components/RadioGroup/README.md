# RadioGroup

RadioGroup is a set of native radio buttons for choices inside a dialog body; each option has a label and an optional muted description.

**Code:** `packages/ui/kit/src/RadioGroup.tsx`, `radio.css`.

**Props:** `options` (`{ value, label, description?, disabled? }[]`), `value`, `onChange`, `name`, `aria-label`.

**Tokens:** 14px dot with a `muted` 1px ring (`line-strong` is too faint for an empty dot), checked ring and centre `ink`, `surface` fill, description `text-sm` `muted`, gap `space-sm`, disabled `opacity-disabled`.

**Behaviour:** the transparent native input sits over the dot, so arrow keys, focus and screen readers behave natively. Focus shows a 2px `focus` ring around the dot.
