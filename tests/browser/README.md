# Browser layout tests

`tests/org-card-layout.test.mjs` builds `tests/browser/org-card` (the real `AgentRail` with a seeded store) with Vite into a
temp dir and measures the Org cards in `chrome-headless-shell` over raw CDP (`cdp.mjs`) at pane widths 243 and 307px. It
catches layout bugs jsdom can't see, such as a component's base `relative` beating a caller's `absolute`.

`tests/chat-header-layout.test.mjs` builds `tests/browser/chat-header` the same way: the real `CommandWindow` (project chat)
once per case from the URL hash (`#width:gh|-:idle|running|queued:lock|-:short|long,…`), each with its own project id in a
borderless pane of that width. The store is seeded and `fetch`/`WebSocket` are stubbed (GETs answer `{}`, anything else gets
a 403, and every request is recorded), so no server is needed and no live event changes a case. It measures the header
(`chat-header/geometry.mjs`) at the 25% chat pane widths 243 and 307px, plus 467px as a control above the `@max-md` compaction,
across GitHub link on/off, idle/running/queued (Stop shows when busy), lock on/off and a short/long project name. Line 2
shows `GM Lumen`. Each case asserts that the row never overflows, and that the status badge and line 2's GM span don't run
under the icon group. The 243px overlaps that are already known are pinned in `KNOWN` (measured px + 0.5) and each gets a
`todo` entry that prints the measured px. If one of them stops overlapping, the test fails so the table gets updated.

`build-serve.mjs` holds the shared Vite build (into a temp dir) and the static server. `cdp.mjs` holds the browser lookup
and the CDP driver.

- Browser: `AF_CHROME_BIN=/path/to/chrome-headless-shell`, else the newest
  `chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell` under `$PLAYWRIGHT_BROWSERS_PATH` or `~/.cache/ms-playwright`
  (install with `npx playwright install chromium-headless-shell`). With no browser the test is skipped.
- Run alone: `npm run test:browser` (both files). They are also part of `npm test`.
- Nothing is written to `client/dist`. The browser runs in its own process group and is killed in `after()`.
