# addons.mozilla.org listing

Texts for the AMO submission form, kept here so the listing is versioned with the code.

## Name

Discover Player for Bandcamp

## Add-on URL slug

bandcamp-discover-player

## Summary (max 250 characters)

Play Bandcamp discover pages, artist discographies and recommendations from your toolbar: in order or shuffled, one track per release or whole releases.

## Description

Turns a Bandcamp discover page into a playlist.

How to use it:
1. Open a genre on bandcamp.com/discover.
2. Click the toolbar icon and press "play this page".

What it does:
- Plays the releases on the page and loads more as you scroll or listen.
- One track per release or every release in full, in order or shuffled.
- Repeats the current release (beta, full releases only).
- Shows lyrics for tracks that have them.
- On an artist's or label's page, plays their whole discography, newest or oldest first.
- "You may also like" plays what Bandcamp recommends for the current release.
- The heart adds a release or track to your wishlist (log in on bandcamp.com first).
- Keeps playing when the popup is closed. Media keys work.

Unofficial, not affiliated with Bandcamp. Talks only to Bandcamp and collects no data.

Source code: https://github.com/katokdoescode/bandcamp-discover-player

## Translations

The summary and description are also published in German, French, Spanish, Polish, Ukrainian, Russian, Serbian, Turkish and Georgian: see [firefox-listing-translations.md](firefox-listing-translations.md).

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

Firefox for desktop and Firefox for Android (the popup opens full screen there).

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

### 1.0.2

Single-track releases in an artist's discography show "1 track" and a proper track number instead of "0 tracks" and "null". Releases whose tracklist hasn't loaded yet no longer say "0 tracks".

The wishlist heart works again on discover pages (Bandcamp moved what it needs) and when only an artist's page is open.

### 1.0.1

The player fits phone screens in Firefox for Android, and you can seek by dragging with a finger.

### 1.0.0

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
