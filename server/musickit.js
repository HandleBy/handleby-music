// Apple Music API (MusicKit) layer: developer tokens, one-time user sign-in, and REST
// calls to api.music.apple.com.
//
// Developer tokens come from the HandleBy token service (TOKEN_SERVICE below), which signs
// them with HandleBy LLC's MusicKit key; no key ever lives on the user's machine. The only
// credential this plugin stores is the Music User Token that its own sign-in page
// (startUserAuth) receives from Apple, kept in ~/.handleby-music/.

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".handleby-music");
const TOKEN_FILE = join(STATE_DIR, "user-token.json");
const DEV_TOKEN_FILE = join(STATE_DIR, "developer-token.json");
const API = "https://api.music.apple.com";
export const TOKEN_SERVICE = "https://handleby.ai/api/music/developer-token";
const APP_NAME = "HandleBy Music";
const APP_VERSION = "1.2.2";

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writePrivate(path, obj) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(obj, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

// ---------------------------------------------------------------------------
// Developer token (from the HandleBy token service)
// ---------------------------------------------------------------------------

let devToken = null;
let devTokenExp = 0;

async function fetchServiceToken() {
  const cached = readJSON(DEV_TOKEN_FILE);
  if (cached?.token && cached.expiresAt - Date.now() / 1000 > 86400) return cached;
  const res = await fetch(TOKEN_SERVICE, { headers: { "User-Agent": `${APP_NAME}/${APP_VERSION}` } });
  if (!res.ok) throw new Error(`The HandleBy token service is unavailable (HTTP ${res.status}). Try again later.`);
  const body = await res.json();
  if (!body?.token || !body?.expiresAt) throw new Error("The HandleBy token service returned an unexpected response.");
  writePrivate(DEV_TOKEN_FILE, { token: body.token, expiresAt: body.expiresAt });
  return body;
}

export async function getDeveloperToken() {
  if (devToken && devTokenExp - Date.now() / 1000 > 3600) return devToken;
  const t = await fetchServiceToken();
  devToken = t.token;
  devTokenExp = t.expiresAt;
  return devToken;
}

// ---------------------------------------------------------------------------
// Music User Token
// ---------------------------------------------------------------------------

export const getUserState = () => readJSON(TOKEN_FILE);
export const getStorefront = (fallback = "us") => getUserState()?.storefront || fallback;

function requireUserToken() {
  const s = getUserState();
  if (!s?.token) {
    throw new Error("Apple Music account not connected. Call connect_apple_music_account and sign in once in the browser.");
  }
  return s.token;
}

let authServer = null;

function authPage(token, nonce) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Connect Apple Music — HandleBy Music</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font:16px -apple-system,system-ui,sans-serif;max-width:460px;margin:12vh auto;padding:0 24px;color:#1d1d1f}
  h1{font-size:24px;margin-bottom:8px} p{color:#555;line-height:1.5}
  button{font:inherit;font-weight:600;background:#fa2d48;color:#fff;border:0;border-radius:10px;padding:12px 20px;cursor:pointer}
  button:disabled{opacity:.4;cursor:default} #s{margin-top:20px}
</style>
<script src="https://js-cdn.music.apple.com/musickit/v3/musickit.js" data-web-components async></script>
</head><body>
<h1>Connect Apple Music to Claude</h1>
<p>Sign in with the Apple ID you use for Apple Music. This lets Claude, through the HandleBy Music plugin, read your listening history and recommendations and add music to your library and playlists. Your sign-in token is saved only on this Mac, in ~/.handleby-music. HandleBy Music is not affiliated with Apple.</p>
<button id="go" disabled>Sign in to Apple Music</button>
<p id="s">Loading MusicKit…</p>
<script>
const DEV = ${JSON.stringify(token)}, NONCE = ${JSON.stringify(nonce)};
const s = document.getElementById('s'), go = document.getElementById('go');
document.addEventListener('musickitloaded', async () => {
  try { await MusicKit.configure({ developerToken: DEV, app: { name: ${JSON.stringify(APP_NAME)}, build: ${JSON.stringify(APP_VERSION)} } }); }
  catch (e) { s.textContent = 'MusicKit could not start: ' + e; return; }
  go.disabled = false; s.textContent = '';
});
go.onclick = async () => {
  go.disabled = true; s.textContent = 'Waiting for Apple sign-in…';
  try {
    const m = MusicKit.getInstance();
    const tok = await m.authorize();
    const r = await fetch('/token', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: NONCE, token: tok, storefront: m.storefrontId || null }) });
    s.textContent = r.ok ? 'Connected. You can close this tab and go back to Claude.' : 'Saving the token failed: ' + await r.text();
  } catch (e) { s.textContent = 'Sign-in did not finish: ' + e; go.disabled = false; }
};
</script></body></html>`;
}

export async function startUserAuth() {
  const token = await getDeveloperToken();
  if (authServer) authServer.close();
  const nonce = randomBytes(16).toString("hex");
  const server = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(authPage(token, nonce));
      return;
    }
    if (req.method === "POST" && req.url === "/token") {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 64_000) req.destroy();
      });
      req.on("end", () => {
        try {
          const j = JSON.parse(body);
          if (j.nonce !== nonce || typeof j.token !== "string" || j.token.length < 20) throw new Error("bad request");
          writePrivate(TOKEN_FILE, {
            token: j.token,
            storefront: typeof j.storefront === "string" ? j.storefront : null,
            connectedAt: new Date().toISOString(),
          });
          res.writeHead(200).end("ok");
          setTimeout(() => server.close(), 1000);
        } catch (e) {
          res.writeHead(400).end(String(e.message || e));
        }
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  authServer = server;
  setTimeout(() => server.close(), 15 * 60 * 1000).unref();
  return `http://localhost:${server.address().port}/`;
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

export async function api(path, { method = "GET", query, body, user = true } = {}) {
  const url = new URL(path, API);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const headers = { Authorization: `Bearer ${await getDeveloperToken()}` };
  if (user) headers["Music-User-Token"] = requireUserToken();
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const detail = json?.errors?.map((e) => e.detail || e.title).filter(Boolean).join("; ") || text.slice(0, 300);
    if (res.status === 401) {
      devToken = null;
      try { writePrivate(DEV_TOKEN_FILE, {}); } catch {}
      throw new Error(`Apple rejected the developer token (401); a fresh one will be fetched on the next try. ${detail}`);
    }
    if (res.status === 403 && user)
      throw new Error(`Apple rejected the account token (403); it may have expired. Call connect_apple_music_account to sign in again. ${detail}`);
    throw new Error(`Apple Music API ${res.status}: ${detail}`);
  }
  return json;
}

// Follow `next` links until `max` items are collected.
export async function paginate(path, { query = {}, max = 25, pageSize = 25 } = {}) {
  const out = [];
  let next = path;
  let q = { ...query, limit: Math.min(pageSize, max) };
  while (next && out.length < max) {
    const page = await api(next, { query: q });
    out.push(...(page?.data || []));
    next = page?.next || null;
    q = { limit: Math.min(pageSize, max - out.length) };
    if (next) {
      // `next` already carries offset; keep any original non-paging params.
      const u = new URL(next, API);
      for (const [k, v] of Object.entries(query)) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
      next = u.pathname + u.search;
    }
  }
  return out.slice(0, max);
}

// Compact a resource object for the model.
export function slim(r) {
  if (!r) return r;
  const a = r.attributes || {};
  const o = { type: r.type, id: r.id };
  const name = a.name ?? a.title?.stringForDisplay;
  if (name) o.name = name;
  if (a.artistName) o.artist = a.artistName;
  if (a.albumName) o.album = a.albumName;
  if (a.curatorName) o.curator = a.curatorName;
  if (a.releaseDate) o.released = a.releaseDate;
  if (a.genreNames?.length) o.genres = a.genreNames;
  if (a.durationInMillis) o.durationSec = Math.round(a.durationInMillis / 1000);
  if (a.trackCount) o.trackCount = a.trackCount;
  if (a.contentRating) o.contentRating = a.contentRating;
  if (a.canEdit !== undefined) o.canEdit = a.canEdit;
  if (a.dateAdded) o.dateAdded = a.dateAdded;
  if (a.lastModifiedDate) o.lastModified = a.lastModifiedDate;
  if (a.description?.short || a.description?.standard) o.description = a.description.short || a.description.standard;
  if (a.url) o.url = a.url;
  return o;
}

export const idType = (id, kind = "songs") => {
  if (/^i\./.test(id)) return "library-songs";
  if (/^l\./.test(id)) return "library-albums";
  if (/^p\./.test(id)) return "library-playlists";
  if (/^pl\./.test(id)) return "playlists";
  return kind;
};
