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
- Plays exactly the releases the page shows, including ones loaded with "View more results", and loads more by itself as you scroll or listen to the end.
- Two modes: one track per release, or every release in full.
- Shuffle the order of releases (tracks inside a release stay in order).
- "You may also like": from the release you are listening to, play the releases Bandcamp recommends with it.
- On an artist's or label's page, play all their releases, newest or oldest first.
- Repeat (beta): loop the release you are listening to in full.
- Read the lyrics of the playing track, when the artist has added them.
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

How to test: open https://bandcamp.com/discover/punk+hardcore-punk/digital?s=rand, click the toolbar icon, press "play this page". Switch "full releases" / "shuffle"; reload the page and the popup offers "update list". On an artist's page (e.g. https://twistedteens.bandcamp.com/music) the popup offers "play all releases"; the "lyrics" link appears next to tracks that have lyrics; "You may also like ›" opens the release page's recommendations.

Permissions:
- `webRequest`, `webRequestBlocking`: used only on `https://bandcamp.com/api/discover/1/discover_web*` with `filterResponseData`, to read (never modify) the release list the discover page itself loads, so the player plays exactly what the user sees. The data is passed through unchanged.
- `tabs`: to find the active discover tab and open bandcamp.com tabs.
- `storage`: player settings (mode, shuffle, repeat, artist release order).
- Host permissions `*.bandcamp.com`, `*.bcbits.com`: Bandcamp's API, audio streams and cover art.

The content script on bandcamp.com uses `content.fetch` to make same-origin requests as the page (release tracklists, and wishlist add/remove, which only happens when the user clicks a heart). On artists' own `<name>.bandcamp.com` pages the same content script only reads the band id from the page's `data-band` attribute, when the popup asks. The background page fetches Bandcamp track pages (`*.bandcamp.com/track/…`) to read their lyrics, and release pages to read their "you may also like" section, when the user opens them, and calls `bandcamp.com/api/mobile/25/band_details` for an artist's discography. No remote code is loaded or executed; no data is sent anywhere except to Bandcamp.

## Release notes

### 1.0.0

<!-- Each feature merged into release/1.0.0 adds its line here. -->

- The list loads more releases by itself when you scroll near its end.
- Repeat (beta) in full releases mode loops the current release; next and previous still move between releases.
- Lyrics: tracks that have them show a "lyrics" link; the text opens in place of the list.
- Artist pages: "play all releases" plays an artist's or label's whole discography, newest or oldest first.
- "You may also like": play the releases Bandcamp recommends on the page of the release you are listening to.

### 0.3.0

The release year is shown next to the artist and in the list.

### 0.2.3

Fixes the player after Bandcamp changed its discover data: artists, cover art, track counts and whole releases work again.

### 0.2.2

The popup header no longer scrolls out of view when the queue jumps to the current release.

### 0.2.1

First public release: play a Bandcamp discover page in order or shuffled, one track per release or full releases, wishlist hearts, update after page reloads.
