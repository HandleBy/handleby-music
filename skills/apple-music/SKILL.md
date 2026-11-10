---
name: apple-music
description: Use when the user asks Claude to play, find, organize or analyze music in Apple Music on their Mac, including building, extending or reordering playlists, choosing AirPlay speakers, or reviewing listening history, recommendations or Replay.
---

# Working with Apple Music through HandleBy Music

The HandleBy Music tools reach Apple Music two ways. Pick the right one for each step.

## Two kinds of tools, two kinds of IDs

- **Music app tools** (`now_playing`, `playback_control`, `search_library`, `play_track`, `list_playlists`, `get_playlist`, `create_playlist`, `add_to_playlist`, `remove_from_playlist`, `listening_stats`, AirPlay tools) run locally through the Music app. They use **persistentIDs** (16 hex characters, such as `DEDEF6D66D84E508`) and work only with songs already in the user's library.
- **Apple Music API tools** (`search_catalog`, `add_to_library`, `play_catalog_song`, `create_catalog_playlist`, `add_catalog_songs_to_playlist`, `library_playlists`, `recently_played`, `heavy_rotation`, `recommendations`, `replay`, `charts`, `rate`, `favorite`) use **catalog IDs** (digits, such as `1440771850`), **library IDs** (`i.…` for songs, `p.…` for playlists) and **catalog playlist IDs** (`pl.…`).
- Never pass a persistentID to an API tool or a catalog ID to a Music app tool.

If an API tool says the account isn't connected, call `connect_apple_music_account`, tell the user a sign-in page opened in their browser, and wait for them to finish before retrying. Music app tools keep working without it.

## Building or extending a playlist

1. Read the source: `get_playlist` for the user's playlist, or `search_library` and `listening_stats` to learn their taste.
2. Resolve every song to a catalog ID with `search_catalog`, matching song, artist and album. The results include `durationSec`; sum it to hit a target length. Prefer the version the user already has (remaster, remix, radio edit).
3. Choose additions that fit what the user described. Don't repeat songs already present, and cap any one artist so it doesn't dominate.
4. Order for flow: group by era or sub-style, raise and lower energy deliberately, put transition songs between groups, and avoid the same artist back-to-back unless that's intentional. Apple doesn't provide tempo or key, so describe the order as a judgment of energy and style, not measured BPM.
5. Create the result with `create_catalog_playlist` in one call, with the IDs already in final order, as a new playlist unless the user asked to change the original. The API can't remove or reorder songs in an existing playlist.
6. Confirm with `get_playlist` after about a minute, once iCloud Music Library has synced, and report the track count and total running time.

## Playing music

- A song in the library: `play_track` with a persistentID or a query.
- Any catalog song: `play_catalog_song`. It adds the song to the library and waits up to a minute for it to sync, so tell the user there may be a short wait.
- A playlist: `play_playlist`, optionally with shuffle.
- Speakers: `list_airplay_devices`, then `set_airplay_devices` with the exact names.

## History and taste

- `recently_played` and `heavy_rotation` cover listening on all the user's devices; `listening_stats` covers this Mac's library play counts, which are larger and include all-time totals.
- `replay` returns Apple Music Replay for the latest eligible year; if it returns nothing, the account doesn't have enough history yet.

## Care with writes

Adding to the library, creating playlists, rating and favoriting change the user's Apple Music account on all their devices. Do these only when the user asked for them, and say what changed. `remove_from_playlist` removes entries from a playlist but never deletes songs from the library.
