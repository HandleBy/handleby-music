# HandleBy Music

HandleBy Music lets Claude work with Apple Music on your Mac. Claude can play and control music in the Music app, search your library and the full Apple Music catalog, build and reorder playlists, send audio to AirPlay speakers, and read your listening history, heavy rotation, recommendations and Apple Music Replay.

HandleBy Music is an independent project by HandleBy LLC. It is not affiliated with, endorsed by or sponsored by Apple. Apple Music is a trademark of Apple Inc.

## Requirements

- A Mac with the Music app (macOS 13 or later recommended) and Node.js 18 or later on the `PATH`
- An Apple Music subscription for the account features (catalog playback, adding music, history, recommendations, Replay)
- Claude Code, or Cowork running on your Mac. Claude chat in the desktop app doesn't run plugin servers; for chat, install the desktop extension file instead (below)

## Install

- **From the Claude directory:** open **Customize > Plugins**, search for HandleBy Music, and add it
- **Claude Code:** add it from the directory with `/plugin`, or try a local copy with `claude --plugin-dir ./handleby-music`

- **Claude desktop chat:** download [handleby-music.mcpb](https://handleby.ai/downloads/handleby-music.mcpb) and double-click it

## First run

1. Ask Claude something like "what's playing?". macOS asks whether Claude (or your terminal, in Claude Code) may control Music. Click **OK**. If you clicked Don't Allow, turn it on in **System Settings > Privacy & Security > Automation**.
2. For account features, ask Claude to "connect my Apple Music account". A sign-in page opens in your browser at `http://localhost`. Sign in with your Apple ID and approve access. You only do this once; the sign-in lasts several months.

## What it can do

**On your Mac, through the Music app (works without signing in):**
- Now playing, play, pause, skip, volume, shuffle, repeat and seek
- Search your library and play any song in it
- List, read, play, create, rename and edit your playlists (add or remove songs)
- Choose AirPlay speakers
- Play-count statistics: most played, recently played, recently added, top artists, albums and genres

**Through the Apple Music API (after you sign in):**
- Search the whole Apple Music catalog for songs, albums, artists, playlists and stations, and see the charts
- Play any catalog song, add music to your library, and build playlists from catalog songs
- Account-wide history: recently played tracks and containers, heavy rotation
- Personalized recommendations and your Apple Music Replay summary
- Love, dislike and favorite songs, albums and playlists

## Examples

- "Make me a 90-minute playlist for a dinner party that starts mellow and ends danceable, using my library and anything on Apple Music."
- "Take my playlist *indie sleaze*, reorder it for flow, add an hour of songs that fit, and save it as a new playlist."
- "What have I been listening to most this month, and what does my Replay say my top artists are?"
- "Play *Heads Will Roll* on the living room speaker."
- "Find the Fcukers album and add it to my library."

## Data and privacy

Everything the plugin runs, sends and stores:

| What | Where it goes | When |
| --- | --- | --- |
| AppleScript / JavaScript for Automation commands to the Music app (`osascript`) | Stays on your Mac | Playback, library, playlist, AirPlay and play-count tools |
| `open music://…` to show an Apple Music page in the Music app | Stays on your Mac | `open_in_music`, and as a fallback in `play_catalog_song` |
| A request for a developer token (no personal data, no identifiers beyond a `User-Agent` of `HandleBy-Music/<version>`) | handleby.ai (HandleBy LLC), path `/api/music/developer-token` | When an Apple Music API call needs a token; cached on your Mac for up to 30 days |
| Apple Music API requests with the developer token and your Music User Token (search terms, song and playlist IDs, playlist names and descriptions you ask Claude to create) | api.music.apple.com (Apple) | Account and catalog tools |
| Catalog search terms, only if the Apple Music API is unreachable | itunes.apple.com (Apple) | `search_catalog` fallback |
| The Apple Music sign-in page | A page served from your Mac (localhost), open for 15 minutes; MusicKit JS comes from js-cdn.music.apple.com (Apple) | `connect_apple_music_account` |

Stored on your Mac in `~/.handleby-music/` (readable only by your user): your Music User Token, the cached developer token, and, if you set one, the path to your own MusicKit key.

HandleBy LLC never receives your Apple ID, your Music User Token, your library, your listening history, or anything Claude reads or writes in Apple Music. The token service logs only what Vercel logs for any web request (time, IP address, user agent). Your use of Apple Music is governed by Apple's terms and privacy policy. Full policy: [PRIVACY.md](PRIVACY.md), also at [handleby.ai/music/privacy](https://handleby.ai/music/privacy).

To disconnect, delete `~/.handleby-music/` and remove the plugin. Without the stored Music User Token, the plugin can no longer reach your Apple Music account.

## Using your own MusicKit key (optional)

Apple Developer Program members can skip the HandleBy token service by asking Claude to "use my own MusicKit key" with their Team ID, Key ID and the path to their `.p8` file (`configure_apple_music_api`), or by setting `AM_TEAM_ID`, `AM_KEY_ID` and `AM_PRIVATE_KEY_PATH`. Tokens are then signed on your Mac and nothing goes to HandleBy LLC.

## Limits

- The Up Next queue can't be read or changed; Apple doesn't expose it to scripts or the API.
- `play_catalog_song` adds a song to your library first and waits up to a minute for iCloud Music Library to sync it to the Music app.
- The Apple Music API can only add songs to playlists, not remove them; removal works for playlists through the Music app tools.
- Tempo and key aren't available from Apple, so playlist "flow" is Claude's judgment of energy and style.

## Support

Email jaden@kellans.com.

## License

MIT. See [LICENSE](LICENSE).
