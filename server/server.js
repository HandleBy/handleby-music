#!/usr/bin/env node
// HandleBy Music: an MCP server that lets Claude work with Apple Music on a Mac.
//
// - Music app control (playback, library, playlists, AirPlay, play-count stats) runs
//   locally through AppleScript / JXA (osascript). Nothing leaves the Mac.
// - Account features (catalog search, adding to library, history, recommendations,
//   Replay, ratings, favorites) call Apple's Apple Music API at api.music.apple.com,
//   using a developer token from the HandleBy token service and the user's own Music
//   User Token, which is stored only on this Mac. See README.md, "Data and privacy".
// - If the Apple Music API is unreachable, catalog search falls back to Apple's public
//   iTunes Search API (itunes.apple.com).

import { execFile } from "node:child_process";
import { McpServer, z } from "./mcp.js";
import * as mk from "./musickit.js";

const OSASCRIPT = "/usr/bin/osascript";
const OPEN = "/usr/bin/open";
const STOREFRONT = "us"; // default until the user's own storefront is known from sign-in
const LIBRARY_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// osascript helpers
// ---------------------------------------------------------------------------

function run(cmd, args, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 512 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = `${stderr || ""} ${err.message || ""}`;
        if (/-1743|Not authori[sz]ed to send Apple events/i.test(msg)) {
          reject(new Error(
            "macOS blocked Claude from controlling the Music app. Open System Settings → Privacy & Security → Automation, find Claude, and turn on Music, then try again."
          ));
        } else if (/-600|isn.t running/i.test(msg)) {
          reject(new Error("The Music app isn't running and couldn't be launched."));
        } else {
          reject(new Error((stderr || err.message || "osascript failed").trim()));
        }
        return;
      }
      resolve(stdout.replace(/\n$/, ""));
    });
  });
}

const applescript = (src, args = []) => run(OSASCRIPT, ["-e", src, ...args.map(String)]);
const jxa = async (src, args = []) => {
  const out = await run(OSASCRIPT, ["-l", "JavaScript", "-e", src, ...args.map(String)]);
  return out ? JSON.parse(out) : null;
};

const ok = (data) => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e.message || e}` }], isError: true });
const wrap = (fn) => async (args) => {
  try {
    return ok(await fn(args || {}));
  } catch (e) {
    return fail(e);
  }
};

// ---------------------------------------------------------------------------
// JXA scripts (reads, returned as JSON)
// ---------------------------------------------------------------------------

const JXA_NOW_PLAYING = `
function run() {
  var M = Application('Music');
  if (!M.running()) return JSON.stringify({ state: 'not running' });
  function g(f) { try { var v = f(); return v === undefined ? null : v; } catch (e) { return null; } }
  var r = { state: g(function(){ return M.playerState(); }),
            volume: g(function(){ return M.soundVolume(); }),
            shuffle: g(function(){ return M.shuffleEnabled(); }),
            repeat: g(function(){ return M.songRepeat(); }) };
  var c = M.currentTrack;
  var name = g(function(){ return c.name(); });
  if (name !== null) {
    r.track = { name: name,
                artist: g(function(){ return c.artist(); }),
                album: g(function(){ return c.album(); }),
                year: g(function(){ return c.year(); }),
                genre: g(function(){ return c.genre(); }),
                durationSec: g(function(){ return c.duration(); }),
                persistentID: g(function(){ return c.persistentID(); }) };
    r.positionSec = g(function(){ return M.playerPosition(); });
  }
  var stream = g(function(){ return M.currentStreamTitle(); });
  if (stream) r.streamTitle = stream;
  var pl = g(function(){ return M.currentPlaylist.name(); });
  if (pl) r.playlist = pl;
  return JSON.stringify(r);
}`;

const JXA_LIBRARY = `
function run() {
  var M = Application('Music');
  var t = M.libraryPlaylists[0].tracks;
  function bulk(f, n) { try { return f(); } catch (e) { var a = []; for (var i = 0; i < n; i++) a.push(null); return a; } }
  var names = t.name();
  var n = names.length;
  var artist = bulk(function(){ return t.artist(); }, n);
  var album = bulk(function(){ return t.album(); }, n);
  var albumArtist = bulk(function(){ return t.albumArtist(); }, n);
  var genre = bulk(function(){ return t.genre(); }, n);
  var pid = bulk(function(){ return t.persistentID(); }, n);
  var plays = bulk(function(){ return t.playedCount(); }, n);
  var played = bulk(function(){ return t.playedDate(); }, n);
  var added = bulk(function(){ return t.dateAdded(); }, n);
  var dur = bulk(function(){ return t.duration(); }, n);
  var year = bulk(function(){ return t.year(); }, n);
  function ms(d) { return d && d.getTime ? d.getTime() : null; }
  var out = [];
  for (var i = 0; i < n; i++) {
    out.push([names[i], artist[i], album[i], albumArtist[i], genre[i], pid[i], plays[i], ms(played[i]), ms(added[i]), dur[i], year[i]]);
  }
  return JSON.stringify(out);
}`;

const JXA_PLAYLISTS = `
function run() {
  var M = Application('Music');
  var p = M.userPlaylists;
  var names = p.name(), ids = p.persistentID(), smart = p.smart(), kind = p.specialKind();
  var out = [];
  for (var i = 0; i < names.length; i++) {
    var count = null;
    try { count = p[i].tracks.length; } catch (e) {}
    out.push({ name: names[i], persistentID: ids[i], smart: smart[i], kind: String(kind[i]), trackCount: count });
  }
  return JSON.stringify(out);
}`;

const JXA_PLAYLIST_TRACKS = `
function run(argv) {
  var M = Application('Music');
  var key = argv[0], limit = parseInt(argv[1], 10);
  var hits = M.userPlaylists.whose({ persistentID: key })();
  if (!hits.length) hits = M.userPlaylists.whose({ name: key })();
  if (!hits.length) throw new Error('No playlist found matching "' + key + '"');
  var p = hits[0];
  var t = p.tracks;
  var names = t.name(), artist = t.artist(), album = t.album(), ids = t.persistentID();
  var out = [];
  for (var i = 0; i < names.length && i < limit; i++) out.push({ position: i + 1, name: names[i], artist: artist[i], album: album[i], persistentID: ids[i] });
  return JSON.stringify({ playlist: p.name(), persistentID: p.persistentID(), totalTracks: names.length, tracks: out });
}`;

// ---------------------------------------------------------------------------
// AppleScript scripts (writes / controls)
// ---------------------------------------------------------------------------

const AS_PLAY_TRACK = `
on run argv
  tell application "Music"
    set t to (first track of library playlist 1 whose persistent ID is (item 1 of argv))
    play t
    return (name of t) & " — " & (artist of t)
  end tell
end run`;

const AS_PLAY_PLAYLIST = `
on run argv
  set key to item 1 of argv
  set shuf to item 2 of argv
  tell application "Music"
    set hits to (every user playlist whose persistent ID is key)
    if hits is {} then set hits to (every user playlist whose name is key)
    if hits is {} then error "No playlist found matching \\"" & key & "\\""
    set p to item 1 of hits
    if shuf is "true" then set shuffle enabled to true
    if shuf is "false" then set shuffle enabled to false
    play p
    return name of p
  end tell
end run`;

const AS_CREATE_PLAYLIST = `
on run argv
  tell application "Music"
    set p to make new user playlist with properties {name:(item 1 of argv)}
    if (count of argv) > 1 and (item 2 of argv) is not "" then
      try
        set description of p to (item 2 of argv)
      end try
    end if
    return persistent ID of p
  end tell
end run`;

const AS_ADD_TO_PLAYLIST = `
on run argv
  tell application "Music"
    set key to item 1 of argv
    set hits to (every user playlist whose persistent ID is key)
    if hits is {} then set hits to (every user playlist whose name is key)
    if hits is {} then error "No playlist found matching \\"" & key & "\\""
    set p to item 1 of hits
    if smart of p then error "Smart playlists can't be edited directly."
    set added to 0
    set notFound to {}
    repeat with i from 2 to count of argv
      set tid to item i of argv
      try
        duplicate (first track of library playlist 1 whose persistent ID is tid) to p
        set added to added + 1
      on error
        set end of notFound to tid
      end try
    end repeat
    set AppleScript's text item delimiters to ","
    return (added as text) & "|" & (notFound as text)
  end tell
end run`;

const AS_REMOVE_FROM_PLAYLIST = `
on run argv
  tell application "Music"
    set key to item 1 of argv
    set hits to (every user playlist whose persistent ID is key)
    if hits is {} then set hits to (every user playlist whose name is key)
    if hits is {} then error "No playlist found matching \\"" & key & "\\""
    set p to item 1 of hits
    if smart of p then error "Smart playlists can't be edited directly."
    set removed to 0
    repeat with i from 2 to count of argv
      set tid to item i of argv
      set matches to (every track of p whose persistent ID is tid)
      repeat with t in matches
        delete t
        set removed to removed + 1
      end repeat
    end repeat
    return removed
  end tell
end run`;

const AS_RENAME_PLAYLIST = `
on run argv
  tell application "Music"
    set key to item 1 of argv
    set hits to (every user playlist whose persistent ID is key)
    if hits is {} then set hits to (every user playlist whose name is key)
    if hits is {} then error "No playlist found matching \\"" & key & "\\""
    set p to item 1 of hits
    set name of p to (item 2 of argv)
    return name of p
  end tell
end run`;

const AS_FAVORITE = `
on run argv
  set v to ((item 1 of argv) is "true")
  tell application "Music"
    if player state is stopped then error "Nothing is playing."
    try
      set favorited of current track to v
      return "favorited=" & (v as text) & ": " & (name of current track)
    on error
      set loved of current track to v
      return "loved=" & (v as text) & ": " & (name of current track)
    end try
  end tell
end run`;

const AS_AIRPLAY_LIST = `
tell application "Music"
  set out to ""
  repeat with d in AirPlay devices
    set out to out & (name of d) & tab & (selected of d as text) & tab & (kind of d as text) & tab & (available of d as text) & linefeed
  end repeat
  return out
end tell`;

const AS_AIRPLAY_SET = `
on run argv
  tell application "Music"
    set picked to {}
    repeat with nm in argv
      set picked to picked & (every AirPlay device whose name is (nm as text))
    end repeat
    if picked is {} then error "None of those AirPlay devices were found."
    set current AirPlay devices to picked
    set out to {}
    repeat with d in current AirPlay devices
      set end of out to name of d
    end repeat
    set AppleScript's text item delimiters to ", "
    return out as text
  end tell
end run`;


const AS_FIND_TRACK = `
on run argv
  tell application "Music"
    set hits to (every track of library playlist 1 whose name is (item 1 of argv) and artist is (item 2 of argv))
    if hits is {} then set hits to (every track of library playlist 1 whose name is (item 1 of argv))
    if hits is {} then return ""
    return persistent ID of (item 1 of hits)
  end tell
end run`;

const CONTROL_SCRIPTS = {
  play: 'tell application "Music" to play',
  pause: 'tell application "Music" to pause',
  toggle: 'tell application "Music" to playpause',
  stop: 'tell application "Music" to stop',
  next: 'tell application "Music" to next track',
  previous: 'tell application "Music" to previous track',
  restart_track: 'tell application "Music" to back track',
};

// ---------------------------------------------------------------------------
// Library cache + helpers
// ---------------------------------------------------------------------------

let libraryCache = null;
let libraryCacheAt = 0;

async function getLibrary(force = false) {
  if (!force && libraryCache && Date.now() - libraryCacheAt < LIBRARY_TTL_MS) return libraryCache;
  const rows = (await jxa(JXA_LIBRARY)) || [];
  libraryCache = rows.map((r) => ({
    name: r[0] || "",
    artist: r[1] || "",
    album: r[2] || "",
    albumArtist: r[3] || "",
    genre: r[4] || "",
    persistentID: r[5],
    playCount: r[6] || 0,
    lastPlayed: r[7] ? new Date(r[7]).toISOString() : null,
    dateAdded: r[8] ? new Date(r[8]).toISOString() : null,
    durationSec: r[9] ? Math.round(r[9]) : null,
    year: r[10] || null,
  }));
  libraryCacheAt = Date.now();
  return libraryCache;
}

const norm = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const brief = (t) => ({
  name: t.name,
  artist: t.artist,
  album: t.album,
  year: t.year,
  playCount: t.playCount,
  lastPlayed: t.lastPlayed,
  persistentID: t.persistentID,
});

function searchTracks(lib, { query, artist, album, genre }) {
  const q = norm(query);
  const tokens = q ? q.split(" ") : [];
  const fa = norm(artist);
  const fal = norm(album);
  const fg = norm(genre);
  const scored = [];
  for (const t of lib) {
    const n = norm(t.name);
    const a = norm(t.artist) + " " + norm(t.albumArtist);
    const al = norm(t.album);
    if (fa && !a.includes(fa)) continue;
    if (fal && !al.includes(fal)) continue;
    if (fg && !norm(t.genre).includes(fg)) continue;
    let score = 1;
    if (tokens.length) {
      const hay = `${n} ${a} ${al}`;
      if (!tokens.every((tok) => hay.includes(tok))) continue;
      if (n === q) score += 100;
      else if (n.startsWith(q)) score += 40;
      else if (n.includes(q)) score += 20;
      if (a.includes(q)) score += 15;
      if (al.includes(q)) score += 10;
    }
    score += Math.min(t.playCount, 50) / 10;
    scored.push([score, t]);
  }
  scored.sort((x, y) => y[0] - x[0]);
  return scored.map((s) => s[1]);
}

function topCounts(items, keyFn, weightFn, limit) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + weightFn(it));
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Catalog (public iTunes Search API, no account needed)
// ---------------------------------------------------------------------------

async function catalogSearch(term, type, limit) {
  const entity = { songs: "song", albums: "album", artists: "musicArtist" }[type];
  const url = new URL("https://itunes.apple.com/search");
  url.search = new URLSearchParams({ term, media: "music", entity, limit: String(limit), country: STOREFRONT }).toString();
  const res = await fetch(url, { headers: { "User-Agent": "HandleBy-Music/1.2" } });
  if (!res.ok) throw new Error(`Catalog search failed: HTTP ${res.status}`);
  const body = await res.json();
  return (body.results || []).map((r) => {
    if (type === "artists")
      return { artist: r.artistName, genre: r.primaryGenreName, artistId: r.artistId, url: r.artistLinkUrl?.replace(/[?&]uo=\d+$/, "") };
    if (type === "albums")
      return {
        album: r.collectionName,
        artist: r.artistName,
        tracks: r.trackCount,
        released: r.releaseDate?.slice(0, 10),
        genre: r.primaryGenreName,
        explicit: r.collectionExplicitness === "explicit",
        albumId: r.collectionId,
        url: r.collectionViewUrl?.replace(/[?&]uo=\d+$/, ""),
      };
    return {
      name: r.trackName,
      artist: r.artistName,
      album: r.collectionName,
      released: r.releaseDate?.slice(0, 10),
      genre: r.primaryGenreName,
      durationSec: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : null,
      explicit: r.trackExplicitness === "explicit",
      songId: r.trackId,
      url: r.trackViewUrl?.replace(/[?&]uo=\d+$/, ""),
    };
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "handleby-music", title: "HandleBy Music", version: "1.2.2" });

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

server.registerTool(
  "now_playing",
  {
    title: "Now playing",
    description:
      "What the Music app is playing right now: track, artist, album, position, player state, volume, shuffle and repeat.",
    inputSchema: {},
    annotations: READ,
  },
  wrap(() => jxa(JXA_NOW_PLAYING))
);

server.registerTool(
  "playback_control",
  {
    title: "Playback control",
    description:
      "Control playback in the Music app: play, pause, toggle, stop, next, previous, or restart_track (jump to the start of the current song).",
    inputSchema: {
      action: z.enum(["play", "pause", "toggle", "stop", "next", "previous", "restart_track"]),
    },
    annotations: WRITE,
  },
  wrap(async ({ action }) => {
    await applescript(CONTROL_SCRIPTS[action]);
    return jxa(JXA_NOW_PLAYING);
  })
);

server.registerTool(
  "set_playback_options",
  {
    title: "Set volume, shuffle, repeat or position",
    description:
      "Change Music app settings. Any combination of: volume (0-100), shuffle (true/false), repeat (off, one, all), positionSec (seek within the current song).",
    inputSchema: {
      volume: z.number().int().min(0).max(100).optional(),
      shuffle: z.boolean().optional(),
      repeat: z.enum(["off", "one", "all"]).optional(),
      positionSec: z.number().min(0).optional(),
    },
    annotations: WRITE,
  },
  wrap(async ({ volume, shuffle, repeat, positionSec }) => {
    const lines = [];
    if (volume !== undefined) lines.push(`set sound volume to ${volume}`);
    if (shuffle !== undefined) lines.push(`set shuffle enabled to ${shuffle}`);
    if (repeat !== undefined) lines.push(`set song repeat to ${repeat}`);
    if (positionSec !== undefined) lines.push(`set player position to ${positionSec}`);
    if (!lines.length) throw new Error("Pass at least one of volume, shuffle, repeat, positionSec.");
    await applescript(`tell application "Music"\n${lines.join("\n")}\nend tell`);
    return jxa(JXA_NOW_PLAYING);
  })
);

server.registerTool(
  "search_library",
  {
    title: "Search my library",
    description:
      "Search the songs in the user's Apple Music library (including Apple Music songs they've added). Free-text query matches song, artist and album; optional artist/album/genre filters narrow it. Returns persistentIDs for play_track and add_to_playlist.",
    inputSchema: {
      query: z.string().optional().describe("Words to match against song, artist and album"),
      artist: z.string().optional(),
      album: z.string().optional(),
      genre: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(25),
    },
    annotations: READ,
  },
  wrap(async ({ query, artist, album, genre, limit = 25 }) => {
    if (!query && !artist && !album && !genre) throw new Error("Give a query or at least one filter.");
    const lib = await getLibrary();
    const hits = searchTracks(lib, { query, artist, album, genre });
    return { totalMatches: hits.length, results: hits.slice(0, limit).map(brief) };
  })
);

server.registerTool(
  "play_track",
  {
    title: "Play a library song",
    description:
      "Play a song from the user's library by persistentID (from search_library or a playlist). Alternatively pass a query and the best library match plays.",
    inputSchema: {
      persistentID: z.string().optional(),
      query: z.string().optional().describe("Song search, e.g. 'Delilah Fred again'"),
    },
    annotations: WRITE,
  },
  wrap(async ({ persistentID, query }) => {
    let id = persistentID;
    if (!id) {
      if (!query) throw new Error("Pass persistentID or query.");
      const hit = searchTracks(await getLibrary(), { query })[0];
      if (!hit) throw new Error(`Nothing in the library matches "${query}". Try search_catalog for Apple Music songs not in the library.`);
      id = hit.persistentID;
    }
    const played = await applescript(AS_PLAY_TRACK, [id]);
    return `Playing: ${played}`;
  })
);

server.registerTool(
  "list_playlists",
  {
    title: "List my playlists",
    description: "List the user's playlists with track counts and persistentIDs. Smart playlists and folders are flagged.",
    inputSchema: {},
    annotations: READ,
  },
  wrap(() => jxa(JXA_PLAYLISTS))
);

server.registerTool(
  "get_playlist",
  {
    title: "Get playlist tracks",
    description: "List the songs in one of the user's playlists, by playlist name or persistentID.",
    inputSchema: {
      playlist: z.string().describe("Playlist name or persistentID"),
      limit: z.number().int().min(1).max(1000).default(200),
    },
    annotations: READ,
  },
  wrap(({ playlist, limit = 200 }) => jxa(JXA_PLAYLIST_TRACKS, [playlist, limit]))
);

server.registerTool(
  "play_playlist",
  {
    title: "Play a playlist",
    description: "Start playing one of the user's playlists, optionally setting shuffle first.",
    inputSchema: {
      playlist: z.string().describe("Playlist name or persistentID"),
      shuffle: z.boolean().optional(),
    },
    annotations: WRITE,
  },
  wrap(async ({ playlist, shuffle }) => {
    const name = await applescript(AS_PLAY_PLAYLIST, [playlist, shuffle === undefined ? "" : String(shuffle)]);
    return `Playing playlist: ${name}${shuffle ? " (shuffled)" : ""}`;
  })
);

server.registerTool(
  "create_playlist",
  {
    title: "Create a playlist",
    description:
      "Create a new playlist in the user's library, optionally with a description and an initial list of library songs (persistentIDs). Syncs to their other devices through iCloud Music Library.",
    inputSchema: {
      name: z.string().min(1),
      description: z.string().optional(),
      trackIDs: z.array(z.string()).optional().describe("persistentIDs of library songs to add"),
    },
    annotations: WRITE,
  },
  wrap(async ({ name, description, trackIDs }) => {
    const id = await applescript(AS_CREATE_PLAYLIST, [name, description || ""]);
    let added = 0;
    let missing = [];
    if (trackIDs?.length) {
      const [a, m] = (await applescript(AS_ADD_TO_PLAYLIST, [id, ...trackIDs])).split("|");
      added = Number(a);
      missing = m ? m.split(",") : [];
    }
    return { created: name, persistentID: id, tracksAdded: added, notFound: missing };
  })
);

server.registerTool(
  "add_to_playlist",
  {
    title: "Add songs to a playlist",
    description: "Add library songs (by persistentID) to one of the user's playlists.",
    inputSchema: {
      playlist: z.string().describe("Playlist name or persistentID"),
      trackIDs: z.array(z.string()).min(1),
    },
    annotations: WRITE,
  },
  wrap(async ({ playlist, trackIDs }) => {
    const [a, m] = (await applescript(AS_ADD_TO_PLAYLIST, [playlist, ...trackIDs])).split("|");
    return { tracksAdded: Number(a), notFound: m ? m.split(",") : [] };
  })
);

server.registerTool(
  "remove_from_playlist",
  {
    title: "Remove songs from a playlist",
    description:
      "Remove songs (by persistentID) from one of the user's playlists. The songs stay in the library; only the playlist entries are removed.",
    inputSchema: {
      playlist: z.string().describe("Playlist name or persistentID"),
      trackIDs: z.array(z.string()).min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  wrap(async ({ playlist, trackIDs }) => ({
    entriesRemoved: Number(await applescript(AS_REMOVE_FROM_PLAYLIST, [playlist, ...trackIDs])),
  }))
);

server.registerTool(
  "rename_playlist",
  {
    title: "Rename a playlist",
    description: "Rename one of the user's playlists.",
    inputSchema: { playlist: z.string().describe("Current name or persistentID"), newName: z.string().min(1) },
    annotations: WRITE,
  },
  wrap(async ({ playlist, newName }) => `Renamed to: ${await applescript(AS_RENAME_PLAYLIST, [playlist, newName])}`)
);

server.registerTool(
  "favorite_current_track",
  {
    title: "Favorite the current song",
    description: "Mark (or unmark) the song that's playing now as a Favorite, which also tunes Apple Music recommendations.",
    inputSchema: { favorite: z.boolean().default(true) },
    annotations: WRITE,
  },
  wrap(async ({ favorite = true }) => applescript(AS_FAVORITE, [String(favorite)]))
);

server.registerTool(
  "listening_stats",
  {
    title: "Listening stats",
    description:
      "Summaries of the user's library listening history from play counts and dates: most_played songs, recently_played songs, recently_added songs, top_artists, top_albums, or top_genres (by total plays). Optional sinceDays limits recently_* views.",
    inputSchema: {
      view: z.enum(["most_played", "recently_played", "recently_added", "top_artists", "top_albums", "top_genres"]),
      limit: z.number().int().min(1).max(200).default(25),
      sinceDays: z.number().int().min(1).optional(),
      refresh: z.boolean().default(false).describe("Re-read the library instead of using the 10-minute cache"),
    },
    annotations: READ,
  },
  wrap(async ({ view, limit = 25, sinceDays, refresh = false }) => {
    const lib = await getLibrary(refresh);
    const cutoff = sinceDays ? Date.now() - sinceDays * 86_400_000 : null;
    const after = (iso) => iso && (!cutoff || Date.parse(iso) >= cutoff);
    switch (view) {
      case "most_played":
        return [...lib].sort((a, b) => b.playCount - a.playCount).slice(0, limit).map(brief);
      case "recently_played":
        return lib
          .filter((t) => after(t.lastPlayed))
          .sort((a, b) => Date.parse(b.lastPlayed) - Date.parse(a.lastPlayed))
          .slice(0, limit)
          .map(brief);
      case "recently_added":
        return lib
          .filter((t) => after(t.dateAdded))
          .sort((a, b) => Date.parse(b.dateAdded) - Date.parse(a.dateAdded))
          .slice(0, limit)
          .map((t) => ({ ...brief(t), dateAdded: t.dateAdded }));
      case "top_artists":
        return topCounts(lib, (t) => t.albumArtist || t.artist, (t) => t.playCount, limit).map(([artist, plays]) => ({ artist, plays }));
      case "top_albums":
        return topCounts(lib, (t) => (t.album ? `${t.album} — ${t.albumArtist || t.artist}` : ""), (t) => t.playCount, limit).map(
          ([album, plays]) => ({ album, plays })
        );
      case "top_genres":
        return topCounts(lib, (t) => t.genre, (t) => t.playCount, limit).map(([genre, plays]) => ({ genre, plays }));
    }
  })
);

server.registerTool(
  "library_overview",
  {
    title: "Library overview",
    description: "Size of the user's library: number of songs, artists, albums and genres, and total listening time logged.",
    inputSchema: { refresh: z.boolean().default(false) },
    annotations: READ,
  },
  wrap(async ({ refresh = false }) => {
    const lib = await getLibrary(refresh);
    const plays = lib.reduce((s, t) => s + t.playCount, 0);
    const hours = lib.reduce((s, t) => s + t.playCount * (t.durationSec || 0), 0) / 3600;
    return {
      songs: lib.length,
      artists: new Set(lib.map((t) => t.albumArtist || t.artist).filter(Boolean)).size,
      albums: new Set(lib.map((t) => `${t.album}|${t.albumArtist || t.artist}`).filter((k) => !k.startsWith("|"))).size,
      genres: new Set(lib.map((t) => t.genre).filter(Boolean)).size,
      totalPlays: plays,
      approxHoursListened: Math.round(hours),
    };
  })
);

server.registerTool(
  "list_airplay_devices",
  {
    title: "List AirPlay speakers",
    description: "List AirPlay speakers and TVs the Music app can play to, and which are selected.",
    inputSchema: {},
    annotations: READ,
  },
  wrap(async () => {
    const out = await applescript(AS_AIRPLAY_LIST);
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [name, selected, kind, available] = l.split("\t");
        return { name, selected: selected === "true", kind, available: available === "true" };
      });
  })
);

server.registerTool(
  "set_airplay_devices",
  {
    title: "Choose AirPlay speakers",
    description: "Send Music app audio to one or more AirPlay devices by name (use list_airplay_devices for names). Unlisted devices are deselected.",
    inputSchema: { devices: z.array(z.string()).min(1) },
    annotations: WRITE,
  },
  wrap(async ({ devices }) => `Now playing to: ${await applescript(AS_AIRPLAY_SET, devices)}`)
);

server.registerTool(
  "search_catalog",
  {
    title: "Search the Apple Music catalog",
    description:
      "Search the full Apple Music catalog (not just the user's library) for songs, albums, artists, playlists or stations. Returns catalog IDs usable with add_to_library, play_catalog_song, create_catalog_playlist and add_catalog_songs_to_playlist, plus music.apple.com links.",
    inputSchema: {
      query: z.string().min(1),
      type: z.enum(["songs", "albums", "artists", "playlists", "stations"]).default("songs"),
      limit: z.number().int().min(1).max(25).default(10),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  wrap(async ({ query, type = "songs", limit = 10 }) => {
    const sf = mk.getStorefront(STOREFRONT);
    try {
      const res = await mk.api(`/v1/catalog/${sf}/search`, { query: { term: query, types: type, limit }, user: false });
      return (res?.results?.[type]?.data || []).map(mk.slim);
    } catch (e) {
      if (type === "playlists" || type === "stations") throw e;
      // Fallback: the public iTunes Search API (no IDs usable for library writes beyond songs/albums).
      return catalogSearch(query, type, limit);
    }
  })
);

server.registerTool(
  "open_in_music",
  {
    title: "Open in the Music app",
    description:
      "Open an Apple Music catalog link (song, album, artist or playlist on music.apple.com) in the Music app on this Mac, where the user can play it or add it to their library. It opens the page; it does not start playback by itself.",
    inputSchema: { url: z.string().url() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  wrap(async ({ url }) => {
    const u = new URL(url);
    if (!/^(music|itunes|geo\.music)\.apple\.com$/.test(u.hostname)) throw new Error("Only music.apple.com links can be opened.");
    const target = `music://music.apple.com${u.pathname}${u.search}`;
    await run(OPEN, [target], 15_000);
    return `Opened in Music: ${target}`;
  })
);


// ---------------------------------------------------------------------------
// Apple Music API tools (developer account + one-time sign-in)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idsParam = (ids) => ids.map(String).join(",");
const API_READ = { readOnlyHint: true, openWorldHint: true };
const API_WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

async function resolveApiPlaylist(key) {
  if (/^p\./.test(key)) return key;
  const all = await mk.paginate("/v1/me/library/playlists", { max: 500, pageSize: 100 });
  const hit = all.find((p) => p.attributes?.name === key) || all.find((p) => (p.attributes?.name || "").toLowerCase() === key.toLowerCase());
  if (!hit) throw new Error(`No library playlist named "${key}".`);
  if (hit.attributes?.canEdit === false) throw new Error(`"${key}" can't be edited through the API (Apple marks it read-only).`);
  return hit.id;
}

server.registerTool(
  "apple_music_account_status",
  {
    title: "Apple Music API status",
    description: "Whether the user's Apple Music account is connected, and which storefront is in use.",
    inputSchema: {},
    annotations: READ,
  },
  wrap(async () => {
    const u = mk.getUserState();
    const out = {
      developerToken: `HandleBy token service (${mk.TOKEN_SERVICE})`,
      accountConnected: Boolean(u?.token),
      connectedAt: u?.connectedAt || null,
      storefront: mk.getStorefront(STOREFRONT),
    };
    if (out.accountConnected) {
      try {
        const sf = await mk.api("/v1/me/storefront");
        out.storefront = sf?.data?.[0]?.id || out.storefront;
        out.accountCheck = "ok";
      } catch (e) {
        out.accountCheck = e.message;
      }
    }
    return out;
  })
);

server.registerTool(
  "connect_apple_music_account",
  {
    title: "Connect my Apple Music account",
    description:
      "Open a one-time Apple Music sign-in page in the user's browser on this Mac. After they sign in, their Music User Token is saved locally (valid for months). Call apple_music_account_status afterwards to confirm.",
    inputSchema: { openBrowser: z.boolean().default(true) },
    annotations: WRITE,
  },
  wrap(async ({ openBrowser = true }) => {
    const url = await mk.startUserAuth();
    if (openBrowser) await run(OPEN, [url], 15_000).catch(() => {});
    return `Sign-in page ${openBrowser ? "opened" : "ready"} at ${url} (open it on this Mac). Click "Sign in to Apple Music", approve access, then come back. The page stays available for 15 minutes.`;
  })
);

server.registerTool(
  "recently_played",
  {
    title: "Recently played (account-wide)",
    description:
      "The user's Apple Music listening history across all their devices. kind=tracks gives individual songs; kind=containers gives recently played albums, playlists and stations.",
    inputSchema: {
      kind: z.enum(["tracks", "containers"]).default("tracks"),
      limit: z.number().int().min(1).max(100).default(30),
    },
    annotations: API_READ,
  },
  wrap(async ({ kind = "tracks", limit = 30 }) => {
    const path = kind === "tracks" ? "/v1/me/recent/played/tracks" : "/v1/me/recent/played";
    return (await mk.paginate(path, { max: limit, pageSize: 10 })).map(mk.slim);
  })
);

server.registerTool(
  "heavy_rotation",
  {
    title: "Heavy rotation",
    description: "Albums and playlists the user has been playing most often lately, per Apple Music.",
    inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
    annotations: API_READ,
  },
  wrap(async ({ limit = 10 }) => (await mk.paginate("/v1/me/history/heavy-rotation", { max: limit, pageSize: 10 })).map(mk.slim))
);

server.registerTool(
  "recommendations",
  {
    title: "My recommendations",
    description: "Apple Music's personalized recommendations for the user (the 'Made for You' and 'Listen Now' shelves), with the albums, playlists and stations in each.",
    inputSchema: { limit: z.number().int().min(1).max(30).default(10) },
    annotations: API_READ,
  },
  wrap(async ({ limit = 10 }) => {
    const recs = await mk.paginate("/v1/me/recommendations", { max: limit, pageSize: 10 });
    return recs.map((r) => ({
      shelf: r.attributes?.title?.stringForDisplay || r.attributes?.reason?.stringForDisplay || r.id,
      items: (r.relationships?.contents?.data || []).map(mk.slim),
    }));
  })
);

server.registerTool(
  "replay",
  {
    title: "Apple Music Replay",
    description: "The user's Apple Music Replay summary for the latest eligible year: top artists, albums and songs.",
    inputSchema: {},
    annotations: API_READ,
  },
  wrap(async () => {
    const res = await mk.api("/v1/me/music-summaries", {
      query: { "filter[year]": "latest", views: "top-artists,top-albums,top-songs" },
    });
    const d = res?.data?.[0];
    if (!d) return "Apple returned no Replay data for this account yet.";
    const views = {};
    for (const [k, v] of Object.entries(d.views || {})) views[k] = (v.data || []).map(mk.slim);
    return { year: d.attributes?.year ?? null, period: d.attributes?.period ?? null, ...views };
  })
);

server.registerTool(
  "charts",
  {
    title: "Apple Music charts",
    description: "Current Apple Music top charts for songs, albums or playlists, optionally for one genre ID.",
    inputSchema: {
      type: z.enum(["songs", "albums", "playlists"]).default("songs"),
      genre: z.string().optional().describe("Apple Music genre ID, e.g. 17 for Dance"),
      limit: z.number().int().min(1).max(50).default(20),
    },
    annotations: API_READ,
  },
  wrap(async ({ type = "songs", genre, limit = 20 }) => {
    const sf = mk.getStorefront(STOREFRONT);
    const res = await mk.api(`/v1/catalog/${sf}/charts`, { query: { types: type, genre, limit }, user: false });
    return (res?.results?.[type] || []).map((c) => ({ chart: c.name, items: (c.data || []).map(mk.slim) }));
  })
);

server.registerTool(
  "add_to_library",
  {
    title: "Add to my library",
    description: "Add Apple Music catalog songs, albums or playlists to the user's library (by catalog ID from search_catalog). New items can take a minute to appear in the Music app.",
    inputSchema: {
      songIDs: z.array(z.string()).optional(),
      albumIDs: z.array(z.string()).optional(),
      playlistIDs: z.array(z.string()).optional(),
    },
    annotations: API_WRITE,
  },
  wrap(async ({ songIDs, albumIDs, playlistIDs }) => {
    const query = {};
    if (songIDs?.length) query["ids[songs]"] = idsParam(songIDs);
    if (albumIDs?.length) query["ids[albums]"] = idsParam(albumIDs);
    if (playlistIDs?.length) query["ids[playlists]"] = idsParam(playlistIDs);
    if (!Object.keys(query).length) throw new Error("Pass at least one ID.");
    await mk.api("/v1/me/library", { method: "POST", query });
    libraryCache = null;
    return { added: { songs: songIDs?.length || 0, albums: albumIDs?.length || 0, playlists: playlistIDs?.length || 0 } };
  })
);

server.registerTool(
  "favorite",
  {
    title: "Favorite songs, albums or playlists",
    description: "Add catalog songs, albums, artists or playlists to the user's Apple Music Favorites (favorited songs land in their Favorite Songs playlist).",
    inputSchema: {
      songIDs: z.array(z.string()).optional(),
      albumIDs: z.array(z.string()).optional(),
      artistIDs: z.array(z.string()).optional(),
      playlistIDs: z.array(z.string()).optional(),
    },
    annotations: API_WRITE,
  },
  wrap(async ({ songIDs, albumIDs, artistIDs, playlistIDs }) => {
    const query = {};
    if (songIDs?.length) query["ids[songs]"] = idsParam(songIDs);
    if (albumIDs?.length) query["ids[albums]"] = idsParam(albumIDs);
    if (artistIDs?.length) query["ids[artists]"] = idsParam(artistIDs);
    if (playlistIDs?.length) query["ids[playlists]"] = idsParam(playlistIDs);
    if (!Object.keys(query).length) throw new Error("Pass at least one ID.");
    await mk.api("/v1/me/favorites", { method: "POST", query });
    return "Favorited.";
  })
);

server.registerTool(
  "rate",
  {
    title: "Love or dislike",
    description: "Set the user's rating on a catalog song, album or playlist: love, dislike, or clear. Ratings tune Apple Music recommendations.",
    inputSchema: {
      id: z.string(),
      kind: z.enum(["songs", "albums", "playlists"]).default("songs"),
      rating: z.enum(["love", "dislike", "clear"]),
    },
    annotations: API_WRITE,
  },
  wrap(async ({ id, kind = "songs", rating }) => {
    const path = `/v1/me/ratings/${mk.idType(id, kind)}/${encodeURIComponent(id)}`;
    if (rating === "clear") await mk.api(path, { method: "DELETE" });
    else await mk.api(path, { method: "PUT", body: { type: "rating", attributes: { value: rating === "love" ? 1 : -1 } } });
    return `Rating set: ${rating}`;
  })
);


server.registerTool(
  "library_playlists",
  {
    title: "My playlists (API)",
    description: "List the user's library playlists from Apple Music with their API IDs (p.…) and whether each can be edited. Use these IDs with add_catalog_songs_to_playlist.",
    inputSchema: { limit: z.number().int().min(1).max(500).default(200) },
    annotations: API_READ,
  },
  wrap(async ({ limit = 200 }) => (await mk.paginate("/v1/me/library/playlists", { max: limit, pageSize: 100 })).map(mk.slim))
);

server.registerTool(
  "create_catalog_playlist",
  {
    title: "Create a playlist from Apple Music songs",
    description:
      "Create a new playlist in the user's library filled with Apple Music catalog songs (IDs from search_catalog), including songs not yet in their library. Library song IDs (i.…) also work.",
    inputSchema: {
      name: z.string().min(1),
      description: z.string().optional(),
      songIDs: z.array(z.string()).default([]),
    },
    annotations: API_WRITE,
  },
  wrap(async ({ name, description, songIDs = [] }) => {
    const body = { attributes: { name, ...(description ? { description } : {}) } };
    if (songIDs.length) body.relationships = { tracks: { data: songIDs.map((id) => ({ id, type: mk.idType(id) })) } };
    const res = await mk.api("/v1/me/library/playlists", { method: "POST", body });
    const p = res?.data?.[0];
    return { created: p?.attributes?.name || name, id: p?.id, songs: songIDs.length, note: "It can take a minute to appear in the Music app." };
  })
);

server.registerTool(
  "add_catalog_songs_to_playlist",
  {
    title: "Add Apple Music songs to a playlist",
    description:
      "Append Apple Music catalog songs (or library songs i.…) to one of the user's playlists, by API playlist ID (p.…) or exact playlist name. Songs need not be in the library first.",
    inputSchema: {
      playlist: z.string().describe("API playlist ID (p.…) or playlist name"),
      songIDs: z.array(z.string()).min(1),
    },
    annotations: API_WRITE,
  },
  wrap(async ({ playlist, songIDs }) => {
    const id = await resolveApiPlaylist(playlist);
    await mk.api(`/v1/me/library/playlists/${id}/tracks`, {
      method: "POST",
      body: { data: songIDs.map((s) => ({ id: s, type: mk.idType(s) })) },
    });
    return { playlist: id, songsAdded: songIDs.length };
  })
);

server.registerTool(
  "play_catalog_song",
  {
    title: "Play any Apple Music song",
    description:
      "Play a song from the Apple Music catalog on this Mac, even if it isn't in the user's library: adds it to the library, waits for it to sync to the Music app (up to ~60 s), then plays it.",
    inputSchema: { songID: z.string().describe("Catalog song ID from search_catalog") },
    annotations: API_WRITE,
  },
  wrap(async ({ songID }) => {
    const sf = mk.getStorefront(STOREFRONT);
    const song = (await mk.api(`/v1/catalog/${sf}/songs/${encodeURIComponent(songID)}`, { user: false }))?.data?.[0];
    if (!song) throw new Error(`No catalog song ${songID}.`);
    const { name, artistName, url } = song.attributes;
    let pid = await applescript(AS_FIND_TRACK, [name, artistName]);
    if (!pid) {
      await mk.api("/v1/me/library", { method: "POST", query: { "ids[songs]": songID } });
      libraryCache = null;
      for (let i = 0; i < 12 && !pid; i++) {
        await sleep(5000);
        pid = await applescript(AS_FIND_TRACK, [name, artistName]);
      }
    }
    if (!pid) {
      if (url) await run(OPEN, [url.replace(/^https:/, "music:")], 15_000).catch(() => {});
      return `Added "${name}" by ${artistName} to the library, but it hasn't synced to the Music app yet. Opened it in Music instead; try play_track in a minute.`;
    }
    return `Playing: ${await applescript(AS_PLAY_TRACK, [pid])}`;
  })
);

server.connectStdio();
