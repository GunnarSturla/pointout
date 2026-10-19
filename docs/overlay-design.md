# Overlay design plan

The visual plan for the Overlay's surfaces, written before overlay-polish tickets 04–10
build them. Pinned decisions from those tickets, `GLOSSARY.md` and `docs/motion.md` are
taken as given. Where this plan and a ticket disagree, the ticket wins.

## Subject, audience, primary job

- **Subject:** a developer tool drawn in one shadow root over someone else's running app.
- **Audience:** the developer of that app, mid-task, with a Claude Code session open.
- **Job:** point at an element, say one thing about it, and see where that request went.

## Constraints, confirmed

- **Reads as a tool.** One family of shapes (the edge tab, the floating card), one blue,
  one type size band. None of them take anything from the host's styles.
- **Never restyles the host.** `:host { all: initial }` stays. There is no `@font-face`,
  because a font face declared for a shadow root has to go in the host document. Nothing
  is set on the host but the inline `HOST_STYLE`.
- **Stays small.** 12 px interface text, rows one line high, a 28 px minimized Panel and
  a 380 px Panel.
- **Light and dark.** `color-scheme: light dark` stays. Each token below has a light and a
  dark value, written with `light-dark()`. Under `@media (forced-colors: active)` every
  token falls back to a system colour (`Canvas`, `CanvasText`, `Highlight`, `GrayText`),
  so the Overlay does what the OS says.

## Colour

Six token families. Blue marks the pick. Ink marks actions. The status family marks the
health of a session and of a Pick.

| token | role | light | dark |
| --- | --- | --- | --- |
| `--surface` | card and tab fill | `#ffffff` | `#1e2026` |
| `--surface-sunken` | the Note field, the Session list well | `#f3f4f7` | `#17181d` |
| `--ink` | text, and the Send fill | `#1b1d22` | `#e6e8ee` |
| `--ink-muted` | secondary words: status, age, waiting-for | `#5b606b` | `#a3a8b3` |
| `--line` | hairline borders (decorative) | `#d6d9e0` | `#3a3d46` |
| `--line-strong` | the Note's boundary | `#8c919b` | `#6f7480` |
| `--accent` | Highlight, armed Picker, focus ring, chosen row | `#4f7cff` | `#6f95ff`\* |
| `--ready` | green: Ready, done | `#1f8a4c` | `#3fbf73` |
| `--working` | amber: Working | `#b06f00` | `#e0a526` |
| `--needs` | red: Needs you, held, failed, unknown | `#c8322b` | `#f06a60` |
| `--idle` | grey: sent, queued | `#7a7f8a` | `#8a909c` |

\* The Highlight stays `#4f7cff` in both schemes, as pinned. The dark `--accent` is used
only for the focus ring and for accent text, where `#4f7cff` on the dark surface is too
faint for text.

Tints are mixed, never new hex values: `color-mix(in srgb, var(--x) N%, var(--surface))`.

**Contrast, measured (WCAG 2 relative luminance):**

| pair | light | dark | needs |
| --- | --- | --- | --- |
| ink on surface | 16.86 | 13.29 | 4.5 |
| ink on sunken | 15.33 | 14.47 | 4.5 |
| muted on surface | 6.31 | 6.83 | 4.5 |
| muted (placeholder) on sunken | 5.73 | 7.44 | 4.5 |
| surface on ink (Send label) | 16.86 | 13.29 | 4.5 |
| ink on chosen-row tint (accent 12%) | 14.44 | 10.08 | 4.5 |
| accent (focus ring) on surface | 3.71 | 5.75 | 3 |
| `--line-strong` (Note boundary) on surface | 3.16 | 3.48 | 3 |
| ready dot on surface | 4.38 | 6.91 | 3 |
| working dot on surface | 4.10 | 7.43 | 3 |
| needs dot on surface | 5.32 | 5.38 | 3 |
| idle dot on surface | 4.02 | 5.08 | 3 |
| **white on `#4f7cff` (armed "Picking…")** | **3.71** | **3.71** | **4.5, fails** |

The pinned armed fill fails AA for 12 px text. See open question 1.

Colour is never the only signal. A dot always has its word beside it (Ready, Working,
Needs you) or its state in words as a `title` (the minimized Panel's traffic light).

## Type

- **Family:** `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`. This is required,
  not just the safe choice. The Overlay cannot load a face without declaring it in the
  host document. On every OS the system face is also the one the browser's own chrome and
  devtools use, so it reads as "the browser's", not as "the app's". The host's typography
  then has nothing to clash with. Personality comes from shape and colour instead.
- **Scale:** three steps. Sizes are set in `px` so the host's root font size cannot leak in.

| step | size / line height | weight | used for |
| --- | --- | --- | --- |
| note | 13 / 18 px | 400 | the Note, and the whole Note in an expanded submitted Panel |
| ui | 12 / 16 px | 400; 600 for names and button labels | buttons, Target row, Session list, minimized Panel, Picker |
| small | 11 / 14 px | 400 | idle age, waiting-for, Receipt sub-line, counter, badge |

- **Two weights only:** 400 and 600. Today's 500 goes.
- **Numerals:** `font-variant-numeric: tabular-nums` on the idle age ("3d", "12d"), the
  counter and anything else that counts, so ages line up down the Session list. No
  monospace face.
- **Case:** sentence case everywhere. No all caps and no letter-spacing.
- **Alignment:** everything is left-aligned (inline-start). The Picker's label is the one
  exception: it is centred in its tab.

## Shape and depth

Radii step down from the outermost surface to the innermost:

| element | radius |
| --- | --- |
| open Panel (unsubmitted or expanded submitted) | 10 px |
| minimized Panel | 8 px |
| buttons, Note, Session list well, camera | 6 px |
| Session list row, the Highlight's chip | 4 px |
| Picker and "Back to your pick" | 6 px top, 0 bottom (pinned) |
| status dots | 50%, 8 px across |

- **Borders:** 1 px `--line` on every surface. The Note uses `--line-strong`. The armed
  Picker's border turns `--accent`, so it merges with its fill.
- **Depth encodes layer.** Shadows show how far a thing is from the page, not decoration:
  - Picker: no shadow. It is attached to the viewport edge.
  - minimized Panel: `0 1px 2px rgb(0 0 0 / 12%), 0 4px 12px -4px rgb(0 0 0 / 18%)`.
  - open Panel: `0 2px 4px rgb(0 0 0 / 10%), 0 12px 32px -8px rgb(0 0 0 / 28%)`.
  - In dark mode shadows barely show, so `--line` carries the edge and the surface stays a
    step lighter than most dark hosts (`#1e2026`, not `#121212`).
- **Spacing:** multiples of 2 px. Panel padding is 10 px, gaps are 8 px, and row padding
  is 4 px by 8 px.

## States

The same deltas apply to every button (Send, "Locate & stand by", Target row, Session list
row, camera, offer answers, Picker, "Back to your pick", Withdraw ×). Colour changes take
120 ms for everyone. `scale(0.97)` on press is movement, so it runs only under
no-preference. Hover rules sit behind `(hover: hover) and (pointer: fine)`.

| state | quiet button (ghost) | Send (ink fill) | Picker (armed) |
| --- | --- | --- | --- |
| rest | transparent, `--ink` | `--ink` fill, `--surface` text | `--accent-strong` (`#3a66f0`) fill, white text |
| hover | `--ink` 6% tint | `--ink` mixed 86% with surface | accent mixed 88% with black |
| active | `--ink` 12% tint | `--ink` mixed 76% with surface | accent mixed 78% with black |
| focus-visible | `outline: 2px solid var(--accent); outline-offset: 2px`, plus `box-shadow: 0 0 0 2px var(--surface)` filling the offset gap. The ring then always sits on the surface (3.71 / 5.75), even over the host page or the blue fill | same | same |
| disabled | `--ink-muted` text, no tint, `cursor: default` | `--surface-sunken` fill, `--ink-muted` text | never disabled |

- The chosen Session list row: `--accent` 12% tint (ink on it: 14.44 / 10.08).
- Camera on: `--accent` 12% tint, `--accent` icon. Unavailable: dashed `--line-strong`
  border and a muted icon. It is still clickable, to ask for the reason.
- Refusals and failed states use `--needs` text, never a filled red banner.

## Wireframes

**Picker, at rest.** A peek: 13 px of it is below the edge.

```
                          ╭─────────────╮
                          │  ⌖  Pick    │
══════════════════════════╧═════════════╧═══════════════ viewport bottom
```

**Picker, armed, with "Back to your pick".** The Picker lifts 2 px. "Back to your pick" is
positioned from the Picker's right edge, out of flow, so the Picker's centre does not
move. Its width change eases with `interpolate-size` where supported.

```
                         ┏━━━━━━━━━━━━━━━┓   ↑ 2 px
                         ┃ ⌖  Picking…   ┃ ╭────────────────────╮
═════════════════════════┻━━━━━━━━━━━━━━━┻═╧ Back to your pick  ╧═════
                          (#3a66f0, white)   (surface, ink, 6 px gap)
```

**Open unsubmitted Panel.** The Note grows from 3 lines to 12, then scrolls. The footer
holds the camera, the Target row (which fills the space) and Send.

```
╭──────────────────────────────────────────────────╮
│ ┌──────────────────────────────────────────────┐ │
│ │ What about this element?                     │ │  --surface-sunken
│ │                                              │ │  13/18, grows to 12 lines
│ │                                              │ │
│ └──────────────────────────────────────────────┘ │
│  ┌──┐                                            │
│  │◉ │  ● web-app   Ready            ⌄  ┌──────┐  │  ● = --ready dot
│  └──┘                                  │ Send │  │  Send: ink fill
│                                        └──────┘  │
╰──────────────────────────────────────────────────╯
   camera      Target row (ghost button)      Send / Locate & stand by
```

The Target row, in each state:

```
  ● web-app   Ready  3d               (title on "3d": Idle for 3 days)
  ● web-app   Working                 (amber, pulse under no-preference)
  ● web-app is blocked on a permission prompt  approve it in your terminal
  Choose which session this goes to   (no dot; Send is off)
```

**Session list rows.** They open between the Note and the footer, in a sunken well that
scrolls past 180 px. The grid is dot | name | status | age, so the words line up.

```
│ ┌──────────────────────────────────────────────┐ │
│ │ ●  web-app       Ready                    ✓  │ │  chosen: accent 12% tint
│ │ ●  api-refactor  Working                     │ │
│ │ ●  docs          Needs you  Bash(npm test)   │ │  red dot, rings
│ │ ●  old-spike     Ready      3d               │ │  age: 11 px, tabular
│ │ ●  web-app-2     Ready   started this server │ │  muted 11 px, no pill
│ └──────────────────────────────────────────────┘ │
```

**Minimized Panels in the Stack.** Bottom-right, newest at the bottom, max 320 px, one line.
A second, small line appears only when there is a Receipt to read. The × appears only on
failed, unknown and never-picked-up Panels.

```
                                 ╭──────────────────────────────────╮
                                 │ ●  Button  Make this the prim… ◫ │  grey: title "Sent"
                                 ╰──────────────────────────────────╯
                                 ╭──────────────────────────────────╮
                                 │ ●  Card  Tighten the gap betwe…  │  amber pulse: "Working"
                                 ╰──────────────────────────────────╯
                                 ╭──────────────────────────────────╮
                                 │ ●  NavLink  Wrong href on the… × │  red steady: "Failed"
                                 │    Not delivered. send it again… │  11 px, --needs
                                 ╰──────────────────────────────────╯
   left to right: traffic light, name (600), Note's first line (muted), ◫ camera, × Withdraw
```

**Expanded submitted Panel.** Read-only. It grows up out of its slot, above the Stack. It
is the same card as the unsubmitted Panel, with the Note as text instead of a field.

```
                         ╭──────────────────────────────────────────╮
                         │ ●  Working                     Button  ◫ │  light + state word
                         │                                          │
                         │ Make this the primary action and give it │  13/18, whole Note
                         │ the same height as the input next to it. │  scrolls past 12 lines
                         │                                          │
                         │ To web-app                               │  muted, 12 px
                         ╰──────────────────────────────────────────╯
                                 ╭──────────────────────────────────╮
                                 │▌●  Button  Make this the prim… ◫ │  its slot: accent edge
                                 ╰──────────────────────────────────╯
```

## Principles

1. **Blue means the pick.** `#4f7cff` goes only on what points at an element: the
   Highlight and its chip, the armed Picker, the chosen Target, the countdown and the
   focus ring. Actions are ink. Session and Pick health use the four status colours.
2. **One bold thing: the armed Picker.** A solid blue tab rises 2 px off the viewport
   edge in the same blue as the box following the pointer, so the thing pointing and the
   thing pointed at are one colour. Everything else is surface, a hairline and 12 px type.
3. **Edge tab and floating card.** The Picker belongs to the viewport edge (square bottom,
   no shadow). Panels float over the page (round, shadowed). The shape says which is which.
4. **Colour is never the only signal.** Every dot has a word or a title, and a refusal is
   a sentence.
5. **Quiet by default, loud only when it is waiting on you.** Only Needs you and held get
   rings, and only Working pulses.

## Review against the brief

What the first draft had that is a generic default, and what changed:

- **Send as a solid accent button**, the same blue as everything else. Changed: Send is ink
  fill. Blue is saved for the pick, so the armed Picker is the only solid blue control.
- **One 8 px radius on every surface** (today: Panel 8, Stack chip 8, buttons 6). That is
  the SaaS-card kit. Changed: radii step down with nesting (10 / 8 / 6 / 4), and the
  Picker's square bottom sets it apart.
- **The same soft shadow under every surface** (today `rgb(0 0 0 / 14%)` and `/ 18%`).
  Changed: shadows show layer (none, resting, floating), and the Picker has none.
- **`opacity: 0.75` for secondary text** (today on `.target`, `.row-status`, `.summary`,
  the camera). Its contrast is never stated. Changed: a `--ink-muted` token with measured
  ratios. Opacity is kept for fades only.
- **A characterful display face.** Rejected. It would need `@font-face` in the host
  document. The system face is the one that disappears into any host.
- **Raw harness words** (`idle`, `busy`, `waiting`, "idle for 3d"). Changed: Ready,
  Working, Needs you, and "3d" with a title (ticket 06).

Template tells in the current UI, and what replaces them:

- **`name · status · waitingFor`** (`words.targetLine`, `DOT = ' · '`). Replaced by separate
  elements: dot, name (600), status word (muted), age or waiting-for (11 px). They are
  spaced by the grid, with no glyph between them.
- **Spaced em dash labels:** the counter's `3512 / 3500 — too long to send`, and
  `CANT_SEE_SESSIONS` "Can't see your sessions — sending the slower way". Recommended: "Too
  long to send: 3,512 of 3,500 characters" and "Can't see your sessions. Sending the slower
  way." (`words.ts` belongs to other tickets. This is a recommendation for them.)
- **Outlined pill badge** "started this dev server". Replaced by muted 11 px inline text,
  "started this server". A pill is chrome, and this is a fact.
- There are no all-caps eyebrows, no `→` on buttons and no monospace labels today. Keep it
  so.

## Decisions (approved by the developer, 2026-09-25)

The plan is approved. Its three open questions were settled as recommended:

1. **The armed Picker is filled `#3a66f0`** (white on it is 4.84:1, passing AA for 12 px
   text). `#4f7cff` stays the Highlight, its chip outline and the focus ring. Add
   `--accent-strong: #3a66f0` for the armed fill, in both schemes.
2. **Send is ink**, not blue: the armed Picker is the Overlay's only solid blue control, and
   blue keeps meaning the pick.
3. **An opened submitted Panel keeps its slot in the Stack**, marked with an accent edge, and
   shrinks back into it when closed.
