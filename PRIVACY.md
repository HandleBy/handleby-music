# HandleBy Music privacy policy

Effective November 10, 2026. Publisher: HandleBy LLC (jaden@kellans.com).

HandleBy Music is a plugin and desktop extension that lets Claude control the Music app and use the Apple Music API on your Mac. This policy covers the plugin and the HandleBy token service it uses.

## What stays on your Mac

- Commands to the Music app (playback, library, playlists, AirPlay, play counts) run locally through macOS scripting. Their results go only to Claude, as part of your conversation.
- Your Music User Token, which you grant through the plugin's sign-in page, is stored in `~/.handleby-music/` with permissions limited to your user.

## What goes to Apple

When you use account or catalog features, the plugin sends requests directly from your Mac to Apple's Apple Music API (`api.music.apple.com`) and, as a fallback for catalog search, to the iTunes Search API (`itunes.apple.com`). The sign-in page loads Apple's MusicKit JS from `js-cdn.music.apple.com`. Apple's handling of this data is governed by Apple's own privacy policy.

## What goes to HandleBy LLC

Only a request for a MusicKit developer token, sent to `handleby.ai`. The request contains no account information, no Apple ID, no Music User Token and no music data. Our host, Vercel, records standard request logs (time, IP address, user agent), which we don't combine with any other data, sell or share, and which Vercel retains under its own policy.

## What we don't do

We don't collect, sell, share or use your listening history, library, playlists, searches or conversations. We don't use any data for advertising. We don't charge for, or monetize, access to Apple Music.

## Your controls

Delete `~/.handleby-music/` to remove all stored tokens; without them the plugin can no longer reach your Apple Music account. Uninstall the plugin to stop all requests.

## Contact and changes

Questions: jaden@kellans.com. If this policy changes, the new version and its effective date will be posted in this file.
