# Browser-to-agent element picking

A Vite dev-server plugin that lets a developer select an element in the running app,
type a request about it, and have that reach the Claude Code session they are already
working in — with the element's source location attached.

## Language

### The pick and its parts

**Pick**:
One selection made in the browser overlay, together with whatever the developer typed
about it. The unit that travels from the page to the agent session. Always exactly one
element. The note is optional, and a pick sent without one still travels: it asks the
agent to locate the element and stand by, not to do anything.
_Avoid_: message, event, selection (the last means only the element)

**Pointer**:
The machine-generated part of a pick — element identity, the owner chain, page url.
Structurally constrained, and every part of it either states its own uncertainty or may
be acted on as fact.
_Avoid_: metadata, context, target

**Owner chain**:
The ordered list of JSX call sites that created a picked element, innermost first — each
one the place a component wrote the tag, or passed the props, that produced it. React's
own notion of ownership: a component that merely forwards a node is not on the chain.
Carries the whole chain, never a single location, because the value a developer wants
changed is as often set by an ancestor as by the element's own line.
_Avoid_: stack, ancestors, hierarchy, tree (the DOM and render trees are different, and
longer)

**Confidence**:
What one frame of an owner chain says about itself — exact, approximate with a reason, or
absent with a reason. A property of a frame, never of a pick. Its existence is the rule
that a pick degrades by annotation rather than by refusal: the pointer may carry something
that is not fact, but never silently.
_Avoid_: certainty, accuracy, quality, confidence score (it is a claim, not a number)

**Note**:
The developer's own words about the picked element. Free text, optional, and the only
part of a pick a human writes. Its absence is meaningful rather than degenerate — see
Pick.
_Avoid_: prompt, comment, message, instruction

**Excerpt**:
Content lifted from the page and carried inside a pick as evidence — rendered text, an
input's contents. Never a request, always data. A pick never lifts from the repository:
it carries the location and the agent opens the file itself.
_Avoid_: bare capture (Screen Capture is a different thing), content, payload text

**Screen Capture**:
A cropped image of the physical display around a picked element, taken by the dev server
rather than by the page, and carried as a file path the agent opens rather than as
content. Bounded by the screen, not by the page — it can contain whatever window happened
to be in front of it, which is exactly why it is not an Excerpt.
_Avoid_: screenshot (says nothing about the boundary), image, crop

### Trust

**Standing**:
Whose authority a pick arrives with at the agent session — the developer's, a peer
agent's, unattributed, or none. A property of the envelope, never of the pick's contents.
Unattributed is its own value, not a synonym for none: an envelope can name no sender and
still permit the agent to act.
_Avoid_: provenance, trust level, identity

**Envelope**:
The framing a delivery route wraps a pick in before the agent reads it, and the thing
that fixes its standing. Supplied by the harness, not by this project.
_Avoid_: wrapper, transport, channel (the last means the route itself)

**Fence**:
The delimiter that separates a note or an excerpt from everything around it, carrying a
per-pick nonce so its boundary cannot be forged by the text inside it.
_Avoid_: delimiter, boundary, guard (the last means the ingress check)

**Guard**:
The ingress check on the dev server that decides whether a pick is accepted at all.
_Avoid_: auth, validation, filter

### Targeting

**Candidate**:
A live agent session a pick could be addressed to — one working in the same checkout as the
dev server. Candidacy is existence, not readiness: nothing subscribes to picks, and whether a
session knows what a pick *is* cannot be observed from outside it. So the set of Candidates is
knowable and the set of willing receivers is not.
_Avoid_: handler, listener, subscriber (each implies the session opted in)

**Target**:
The one Candidate a pick is addressed to. Always exactly one — a pick delivered to several
sessions is several agendas, not one request. A Target is named before the pick is written and
re-checked as it is sent, because a session can vanish in between, and it is never silently
exchanged for another.
_Avoid_: recipient, destination, route (the last means the delivery leg itself)

**Receipt**:
The harness's own statement of what became of one Pick, addressed to the dev server rather than
to the developer. Involuntary — it needs no cooperation from the Target's agent — and it names
the Pick rather than the session, which is what separates it from anything the registry can say.
It reports **bad outcomes only**: a Pick that is simply accepted produces none, so silence is not
a Receipt and never evidences arrival.
_Avoid_: acknowledgement, confirmation, delivery report, response

**Withdraw**:
The developer taking back a submitted Pick that went wrong. It undoes whatever the dev server
still holds — the queued Pick, its report-back, its Screen Capture — and nothing it does not: a
Pick already written to a session cannot be recalled, and withdrawing it says so rather than
implying otherwise.
_Avoid_: dismiss (that is only the Panel leaving the page), cancel, delete, recall

**Ack**:
The Target agent's own signal that it has a particular Pick, and later that it has finished with
it. Voluntary, and about the work rather than the message — which is the whole of its difference
from a Receipt. Being voluntary, its absence means nothing was said, never that nothing arrived.
_Avoid_: receipt, confirmation, reply

### The overlay

**Overlay**:
Everything v0 draws into the consumer's page — the Picker, the Highlight, the Panel and the
Stack together. Used throughout the map before it was ever defined. It is one thing to the
developer and one shadow root to the DOM, which is why style isolation is a property of the
Overlay rather than of any part of it.
_Avoid_: widget, toolbar, devtools (the last is a different product)

**Picker**:
The Overlay's persistent affordance — the thing that is there before a Pick exists and arms the
selection. Distinct from the Panel, and the two are constantly conflated because both are
floating and both are small.
_Avoid_: button, dock, toolbar (each fixes a form this project has not chosen yet)

**Highlight**:
The mark the Overlay draws on an element: live and morphing while the Picker is armed, frozen
on the element once it is picked. Anchored to the element rather than to the viewport, so it
travels with the page.
_Avoid_: outline, box, selection (the last means the element itself)

**Panel**:
The surface a Pick opens — where the Note is written, the Target is shown, and the Pick's
status is read afterwards. One Panel per Pick, for the Pick's whole life, and it is a
different thing before and after it is sent. **Unsubmitted**, it is where the Note is still
being written: always open, beside its element, and there is at most one. **Submitted**, it is
a record to read: minimized in the Stack, or opened above the Stack to show its whole Note
and its Target — at most one of those at a time, whatever the unsubmitted one is doing.
Sending a Pick is what turns the one into the other.
_Avoid_: popup, modal, dialog (none of it is modal), tooltip (that is the Highlight's chip),
chip (that is the Highlight's label only)

**Session list**:
The list of Candidates the Panel expands into when the developer chooses a Target, each
shown with whether it is ready, working, or needs the developer. It belongs to the Panel
and to one Pick; it is never the Picker.
_Avoid_: picker (that is the Overlay's persistent affordance), dropdown, menu

**Stack**:
Where the minimized Panels of submitted Picks rest while their fate is unsettled — one per
Pick, and the Overlay's second surface. It exists only while something is outstanding, which
is what separates it from the Picker: the Picker is there before any Pick and after the last
one, the Stack only in between.
_Avoid_: dock, tray, list, queue (the last means the claim-once delivery queue, which is a
different thing and lives on the dev server)
