# Browser layout tests

`tests/org-card-layout.test.mjs` builds `tests/browser/org-card` (the real `AgentRail` with a seeded store) with Vite into a
temp dir and measures the Org cards in `chrome-headless-shell` over raw CDP (`cdp.mjs`) at pane widths 243 and 307px. It
catches layout bugs jsdom can't see, such as a component's base `relative` beating a caller's `absolute`.

- Browser: `AF_CHROME_BIN=/path/to/chrome-headless-shell`, else the newest
  `chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell` under `$PLAYWRIGHT_BROWSERS_PATH` or `~/.cache/ms-playwright`
  (install with `npx playwright install chromium-headless-shell`). With no browser the test is skipped.
- Run alone: `npm run test:browser`. It is also part of `npm test`.
- Nothing is written to `client/dist`. The browser runs in its own process group and is killed in `after()`.
