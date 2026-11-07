# Using the Overlay, in detail

The README covers the basics. This is every behaviour of the Picker, Panel and Stack.
Domain terms are defined in [`GLOSSARY.md`](../GLOSSARY.md); the visual plan is in
[`overlay-design.md`](overlay-design.md).

You are looking at your app in the browser and one element is wrong. Hold Alt/Option,
or click the Picker, and a Highlight follows whatever you hover, with a chip naming the
component and its file. Click, and a Panel opens beside the element. Type a Note and
press Enter. The Pick goes into the inbox of a Claude Code session working in this
checkout, with the element's Owner chain attached:
every JSX call site that produced the element, innermost first, each as
`path:line:col` with a stated Confidence.

- **The Picker** is a small tab at the bottom centre of the page, peeking up from the
  edge with a crosshair and the word **Pick**. It comes out when you hover it or give it
  focus, and stays out while anything is unresolved. Armed, it turns solid blue and
  reads **Picking…**; click it again to stop. When the open Panel has scrolled out of
  view with its element, **Back to your pick** appears beside it.
- **Enter** sends, **Shift+Enter** starts a new line, **Escape** discards. `Escape`
  unwinds one level at a time: picked, then armed, then off.
- With an empty Note the button reads **Locate & stand by**: the agent finds the
  element, reports where it is and changes nothing.
- The Note is capped at 4,000 characters. A counter appears from 3,500.
- **Alt-click another element** before sending and the Pick moves there, keeping your
  Note. While the Panel is open, holding Alt shows a second Highlight on whatever you
  hover, so you see what an Alt-click would pick before you make it. After sending,
  Alt-click starts a new Pick.
- **A Pick has one Panel for its whole life, in two forms.** Before you send, it is
  open beside its element, and there is only ever one. Send shrinks it into the
  **Stack**, bottom right, where it rests **minimized** until its fate is settled: one
  line with a traffic light, the component, the first line of your Note, and a camera
  if a Screen Capture went with it. The light's colour, and the words it shows on
  hover, say what is known: grey *Sent* or *Waiting for the next prompt*; amber
  *Working*; green *Done* (the agent's claim, and it clears itself after about eight
  seconds); red *Needs your approval*, ringing where motion is allowed, when it is
  waiting for you in the terminal; steady red *Failed*, *No acknowledgement yet* or
  *Never picked up*. A second line underneath says
  what happened and what to do next. The Overlay never reports a Pick as delivered on
  the strength of silence.
- **Click a minimized Panel** and it opens above the Stack to be read: the whole Note,
  and which session it went to. One opens at a time. Click it again, or press
  **Escape** inside it, to put it back. The Panel you are still writing keeps its place
  and its focus.
- **Withdraw.** A Pick that went wrong — failed, not acknowledged, never picked up, or
  still queued for your next prompt — has a **×** beside its minimized Panel. It takes
  back whatever the dev server still holds: the queued Pick, its report-back offer, its
  Screen Capture. It cannot take back a Pick already written to a session, and says so:
  *Already sent to `<name>` — it may still act on it*, or, when the hooks carried it,
  *Already delivered to a session — it may still act on it*. A Pick that is still only sent, working, waiting
  on your approval, or done cannot be withdrawn.

## Choosing the session

The Target is the session a Pick goes to, shown in the Panel's footer before you send.
It is preselected, in this order: the session you last sent to from this origin, while
it is still running here; the session whose shell started the dev server; the only
session in this checkout. If none of those applies, Send stays disabled until you
choose.

**There is a way to choose the session.** Click the Target row in the Panel's footer
and it expands to the Session list, every Candidate with a coloured dot and a word
for how it is doing: *Ready*, *Working* or *Needs you*, with what it is waiting for.
A session idle a day or more shows its age, such as *3d*, and the one that started
the dev server says *started this server*. You will rarely need it, because a session is usually
preselected: the one you last chose, or the one that started the dev server.
