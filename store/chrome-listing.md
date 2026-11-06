# Chrome Web Store listing

Texts for the Chrome Web Store developer dashboard, kept here so the listing is versioned with the code.
The short summary shown in the store comes from the manifest `description`.

## Package

Upload `bandcamp-discover-player-<version>-chrome.zip` from the GitHub release.

## Store listing

### Description

Discover Player turns any Bandcamp discover page (for example a genre like punk / hardcore punk, sorted by "surprise me") into a playlist.

How to use it:
1. Open a genre on bandcamp.com/discover.
2. Click the toolbar icon and press "play this page".

Features:
- Plays exactly the releases the page shows, including ones loaded with "View more results", and loads more by itself as you scroll or listen to the end.
- Two modes: one track per release, or every release in full.
- Shuffle the order of releases (tracks inside a release stay in order).
- On an artist's or label's page, play all their releases, newest or oldest first.
- Repeat (beta): loop the release you are listening to in full.
- Read the lyrics of the playing track, when the artist has added them.
- Shows the release year next to the artist and in the list.
- Reloaded the page or changed filters? The player offers to update its list, and the current track keeps playing.
- Add releases or single tracks to your Bandcamp wishlist with the heart button (you need to be logged in on bandcamp.com).
- Keeps playing when the popup is closed. Media keys work.

This is an unofficial extension and is not affiliated with Bandcamp. It talks only to Bandcamp, using your existing Bandcamp session, and collects no data.

Source code: https://github.com/katokdoescode/bandcamp-discover-player

### Category

Lifestyle → Entertainment

### Language

English

### Graphic assets

- Store icon (128×128): `icons/128.png` inside the package
- Screenshots (1280×800): `screenshot-1-tracks.jpg`, `screenshot-2-releases.jpg`
- Small promo tile (440×280): `promo-small-440x280.jpg`

### Additional fields

- Homepage URL: https://github.com/katokdoescode/bandcamp-discover-player
- Support URL: https://github.com/katokdoescode/bandcamp-discover-player/issues

## Privacy practices

### Single purpose description

Plays the releases listed on a Bandcamp discover page, or all releases on an artist's Bandcamp page, as a playlist (in order or shuffled, one track per release or whole releases) from the toolbar popup.

### Permission justifications

- **tabs** — Finds the open bandcamp.com discover tab the user wants to play, and bandcamp.com tabs used to make requests with the user's Bandcamp session (tracklists, wishlist).
- **storage** — Saves the player settings (mode, shuffle, repeat, artist release order) and the current queue, so playback can resume after Chrome closes the audio document.
- **offscreen** — Manifest V3 service workers cannot play audio; an offscreen document with an `<audio>` element plays the tracks while the popup is closed.
- **Host permission `*://*.bandcamp.com/*`** — Reads the discover page's release list and the band id on an artist's page, calls Bandcamp's own endpoints for tracklists, discographies and the wishlist, and reads lyrics from track pages.
- **Host permission `*://*.bcbits.com/*`** — Bandcamp's CDN for audio streams and cover art.

### Remote code

No, I am not using remote code. All JavaScript is packaged with the extension.

### Data usage

Collects none of the listed data types.

Certify all three statements:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

### Privacy policy URL

https://github.com/katokdoescode/bandcamp-discover-player/blob/main/PRIVACY.md

## Distribution

- Visibility: Public
- Regions: All regions
