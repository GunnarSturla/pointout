# Prior art

The tools pointout learned from. What it actually borrows, and under which licence, is in
[`LICENSE-THIRDPARTY`](../LICENSE-THIRDPARTY).

- **[UI-Locator](https://github.com/amir1824/UI-Locator)**: Shift+click copies a
  compact AI prompt to the clipboard. v0 borrows its attribute allowlist.
- **[vite-plugin-herdr](https://github.com/scaccogatto/vite-plugin-herdr)**: pick an
  element, add a prompt, send it to a herdr agent. v0 borrows its fail-closed
  same-origin check and the payload format its Pointer prose grew from.
- **[vite-plugin-opencode](https://github.com/Brendonovich/vite-plugin-opencode)**:
  picker to OpenCode, with source markers injected into JSX at dev time.
- **[Pinpoint](https://github.com/ragrivera/pinpoint)**: pins to a file queue to MCP,
  with a headless worker or a live session blocking in a tool.
- **[vite-plugin-pilot](https://github.com/2234839/vite-plugin-pilot)**: weighted
  toward the agent reading and driving the page. It has a `UserPromptSubmit` hook
  fallback.
- **[MCP Pointer](https://github.com/etsd-tech/mcp-pointer)**: an extension plus an
  MCP server, with React Fiber source mapping. Pull-based.
- **[react-grab](https://github.com/aidenybai/react-grab)**: v0 borrows its deep
  element-at-point hit test.
- **[click-to-react-component](https://github.com/ericclemmons/click-to-component)**
  and **[Locator.js](https://www.locatorjs.com/)**: click to jump to source. v0
  borrows the armed `pointer-events` rule.
- **React DevTools**: v0 borrows its stack-frame parser.
- Agent-to-browser tools (Claude in Chrome, chrome-devtools MCP, Playwright MCP) run
  the other direction, with the agent driving. They complement v0 rather than compete
  with it.
