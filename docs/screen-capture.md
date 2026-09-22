# Screen Capture: where the files are, and when they go

A **Screen Capture** is a cropped image of your physical display around the element
you picked — taken by the dev server with macOS's own `screencapture`, and carried
to the agent as a file path it opens rather than as content.

It is bounded by the screen, not by the page. Whatever window happened to be in
front of your browser at that moment is in the picture. That is the whole reason
this page exists: an image of your display must never be something you discover by
accident, months later, in a temp directory.

## Where they live

```
$TMPDIR/vite-agent-inspect-captures/<pid>-<6 hex>/<capture id>.png
```

One directory per dev server, named after its process, mode `0700`. The startup
posture block prints the path every time the server starts:

```
  screen capture  available — captures are written to /var/folders/…/vite-agent-inspect-captures/54321-9f0ab1 and swept at startup and shutdown
```

## When they go

- **At shutdown**: the dev server deletes its whole directory. Every capture it
  still holds goes with it, including the ones it sent to an agent — so open one
  while the dev server is still running, or copy it out.
- **At startup**: the shared root is swept of everything that is not a live dev
  server's directory. A dev server that was killed rather than closed leaves its
  captures behind, and the next one that starts is the only thing that will ever
  come for them. A directory belonging to a dev server that is still running is
  left alone.
- **When you move the Pick**: the capture taken for the element you left is
  aborted and deleted. Clicking through six elements leaves one file, not six.
- **When you discard the Pick**, or send it with the camera toggle off: deleted.
- **When you send it with the toggle on**: kept until the shutdown sweep, because
  the agent has been handed the path and may not have opened it yet.

## When there is no capture at all

Screen Capture is macOS only, and it fails closed: an empty capture never travels,
and a Pick never quietly loses one. Each of these is stated in the posture block at
startup, again by the capture endpoint when the page asks for one, and again in the
Pick itself if one was meant to travel:

| reason | what happened |
| --- | --- |
| not macOS | v0 crops with macOS's `screencapture`; nothing equivalent is shipped for Linux or Windows |
| no Screen Recording permission | `screencapture` exits successfully and writes nothing when the process that started the dev server has not been granted Screen Recording. Grant it to your **terminal** (System Settings → Privacy & Security → Screen Recording) and restart the dev server — the permission is the parent process's, not the browser's |
| the probe failed | the startup capture could not be taken at all, with the tool's own words |
| the capture took too long | a capture that has not landed in five seconds is killed |

A Pick whose capture was intended and failed still sends. It carries one line
saying so, with the reason:

```
  screen capture  a capture was intended, and failed: the capture took too long (more than 5 s) and was stopped
```

## What travels

One line in the Pointer, holding the absolute path. **No image bytes are sent**, to
the agent session or anywhere else, and nothing is uploaded. If the browser window
is wider than its viewport by more than a few pixels, the line says the capture may
be offset: the server is told where the window is, not where its chrome is, and it
crops as though all of that chrome were on top.
