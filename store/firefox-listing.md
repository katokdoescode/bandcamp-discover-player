# addons.mozilla.org listing

Texts for the AMO submission form, kept here so the listing is versioned with the code.

## Name

Discover Player for Bandcamp

## Add-on URL slug

bandcamp-discover-player

## Summary (max 250 characters)

Play everything on a Bandcamp discover page, in order or shuffled — one track per release or whole releases — from a compact player styled after Bandcamp's own. Wishlist hearts included.

## Description

Discover Player turns any Bandcamp discover page (for example a genre like punk / hardcore punk, sorted by "surprise me") into a playlist.

How to use it:
1. Open a genre on bandcamp.com/discover.
2. Click the toolbar icon and press "play this page".

Features:
- Plays exactly the releases the page shows, including ones loaded with "View more results", and keeps loading more when the list runs out.
- Two modes: one track per release, or every release in full.
- Shuffle the order of releases (tracks inside a release stay in order).
- Shows the release year next to the artist and in the list.
- Reloaded the page or changed filters? The player offers to update its list, and the current track keeps playing.
- Add releases or single tracks to your Bandcamp wishlist with the heart button (you need to be logged in on bandcamp.com).
- Keeps playing when the popup is closed. Media keys work.

This is an unofficial add-on and is not affiliated with Bandcamp. It talks only to Bandcamp, using your existing Bandcamp session, and collects no data.

Source code: https://github.com/katokdoescode/bandcamp-discover-player

## Categories

Photos, Music & Videos

## Tags

bandcamp, music, player, playlist, shuffle

## Support

- Support website: https://github.com/katokdoescode/bandcamp-discover-player/issues
- Homepage: https://github.com/katokdoescode/bandcamp-discover-player

## License

Mozilla Public License, version 2.0

## Privacy policy

Use the text of [PRIVACY.md](../PRIVACY.md).

## Compatibility

Firefox for desktop only. Firefox for Android is not tested yet.

## Notes to reviewer

Source code: the attached sources archive, also at https://github.com/katokdoescode/bandcamp-discover-player (tag matching the version).
Build: Node.js 24, npm 11 — `npm ci && npm run zip:firefox`; output in `.output/firefox-mv2/`. The build is bundled by WXT/Vite but not minified, and is reproducible.

How to test: open https://bandcamp.com/discover/punk+hardcore-punk/digital?s=rand, click the toolbar icon, press "play this page". Switch "full releases" / "shuffle"; reload the page and the popup offers "update list".

Permissions:
- `webRequest`, `webRequestBlocking`: used only on `https://bandcamp.com/api/discover/1/discover_web*` with `filterResponseData`, to read (never modify) the release list the discover page itself loads, so the player plays exactly what the user sees. The data is passed through unchanged.
- `tabs`: to find the active discover tab and open bandcamp.com tabs.
- `storage`: player settings (mode, shuffle).
- Host permissions `*.bandcamp.com`, `*.bcbits.com`: Bandcamp's API, audio streams and cover art.

The content script on bandcamp.com uses `content.fetch` to make same-origin requests as the page (release tracklists, and wishlist add/remove, which only happens when the user clicks a heart). No remote code is loaded or executed; no data is sent anywhere except to Bandcamp.

## Release notes

### 0.3.0

The release year is shown next to the artist and in the list.

### 0.2.2

The popup header no longer scrolls out of view when the queue jumps to the current release.

### 0.2.1

First public release: play a Bandcamp discover page in order or shuffled, one track per release or full releases, wishlist hearts, update after page reloads.
