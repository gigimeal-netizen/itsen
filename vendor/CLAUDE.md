# CLAUDE.md — vendor/

Third-party client bundles that have no client-side package manager to fetch them, so they're committed
directly.

- **`colyseus.js`** — the Colyseus browser client, manually copied from
  `../server/node_modules/colyseus.js/dist/colyseus.js` after `npm install` in `../server/`. Loaded by
  `net.html` before `../src/netMain.js`.

**Never hand-edit files here.** To update, bump the version in `../server/package.json`, `npm install`
in `../server/`, then re-copy the built file over this one — and re-check the wire protocol still works
(see the version-pin note in `../server/CLAUDE.md`; the server intentionally stays on the Colyseus
`0.16.x` line to match what this bundle's decoder expects).
