# Pop & Circumstance

Responsive editorial homepage, separate from the existing Ringside Results DB worker. The original database, migrations and ingestion jobs are unchanged.

## Build and verify

From `newsroom/`:

```sh
node scripts/compile-page.mjs
node --test tests/newsroom.test.mjs
```

Deploy `worker/index.js` as a separate Cloudflare Worker using your chosen hosting configuration. It exports `default.fetch`; no build dependencies are required. `GET /` serves the homepage and `GET /api/videos` retrieves the latest four uploads per official WWE, AEW, TNA and NJPWGLOBAL YouTube feed. Responses are cached for five minutes. Failed channels are reported individually. No YouTube API key is needed.

Edit `worker/page.html` for design and editorial copy. Edit `worker/api.js` for feeds. Run the compiler after edits; commit the generated `worker/index.js` too.

## Content and boundaries

News is a dated October 13, 2026 editorial snapshot with original summaries and links to reporting sources, not an automatic news syndication service. Video uploads refresh on load and with the Refresh button; upload dates are shown separately. Stories, votes and reader profiles use browser localStorage. Login opens a clearly labeled local profile, not a shared authentication service. Shop links to WrestleShop. Results desk links to original result reporting and does not claim to be connected to the repository's D1 database. Connect the existing API in a future server integration when its deployment and credentials are configured; never ship those credentials in frontend code.

Images are externally hosted and attributed. Unavailable photos are labeled; replace with licensed assets for a public commercial launch. Automated checks cover parsing, malformed feeds, partial failures, HTTP routing and client JavaScript syntax. Browser rendering QA was unavailable in the build environment.
