#!/usr/bin/env node
/**
 * Builds the music timelines for angelogonza's site: for every song the
 * site's radio plays, how loud its bass, mids and highs are, 20 times a
 * second, for the whole song, plus its tempo. The site's gooey visualizer
 * reads these (one small file per YouTube video) and moves with the song.
 *
 * For each song on the site playlist (read from the site's own API):
 *   1. pick a YouTube recording with yt-dlp's search (no API quota), scored
 *      as the site scores them: the right length, official audio first,
 *      no live, sped-up, slowed or cover versions;
 *   2. stream its audio through ffmpeg (mono, 22.05 kHz), never to disk;
 *   3. split it into bass (<150 Hz), mids (~1.8 kHz) and highs (>7 kHz),
 *      measure each band's loudness per 50 ms, and find the tempo;
 *   4. write data/v/<videoId>.json, and record the pick in data/tracks.json
 *      (Spotify track id → YouTube video id), which the site's radio then
 *      prefers, so the timeline is of the very recording it plays.
 * Songs visitors sent (planes, requests) are included by their own videos.
 *
 * Only songs without a timeline are processed, so later runs are quick.
 *
 *   SITE_URL=http://localhost:3100 node scripts/build.mjs [--limit N]
 *
 * Needs yt-dlp and ffmpeg on the PATH.
 */
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SITE = (process.env.SITE_URL ?? 'http://localhost:3100').replace(/\/$/, '');
const RATE = 22050;
const FPS = 20;
const HOP = Math.round(RATE / FPS);
const LIMIT = Number(process.argv[process.argv.indexOf('--limit') + 1]) || Infinity;
const CONCURRENCY = 3;

const exists = (p) => access(p).then(() => true, () => false);
const json = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
};

// ---- Picking the recording ------------------------------------------------------

const BAD = /\b(live|cover|karaoke|sped ?up|slowed|nightcore|reverb|8d|instrumental|remix|edit|bass ?boost(ed)?|1 ?hour|loop)\b/i;

/** The best YouTube video for a Spotify song, or null. */
async function pick(track) {
  const q = `${track.artists.split(',')[0]} ${track.title}`;
  let out;
  try {
    ({ stdout: out } = await run('yt-dlp', [`ytsearch8:${q}`, '--dump-json', '--skip-download', '--no-warnings', '--flat-playlist'], { maxBuffer: 32e6 }));
  } catch {
    return null;
  }
  const want = track.durationMs / 1000;
  const own = `${track.title}`.toLowerCase();
  let best = null;
  for (const line of out.trim().split('\n')) {
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (!v.id || !v.duration) continue;
    const off = Math.abs(v.duration - want);
    if (off > 8) continue;
    const title = `${v.title ?? ''}`;
    const channel = `${v.channel ?? v.uploader ?? ''}`;
    // A "remix" or "live" the Spotify title itself names is the right one.
    // Every flagged word in the video's title (not the regex's groups, which
    // can be empty and crashed this on slowed and sped-up songs).
    const flagged = [...title.matchAll(new RegExp(BAD.source, 'gi'))].map((m) => m[0].toLowerCase());
    const bad = flagged.some((w) => !own.includes(w.replace(/\s+/g, ' ')));
    if (bad) continue;
    let score = 10 - off;
    if (/ - topic$/i.test(channel)) score += 6;
    if (/official (audio|music video|video)|audio/i.test(title)) score += 3;
    if (track.artists.split(',').some((a) => channel.toLowerCase().includes(a.trim().toLowerCase()))) score += 2;
    if (!best || score > best.score) best = { id: v.id, score };
  }
  return best?.id ?? null;
}

// ---- Listening --------------------------------------------------------------------

/** The whole song as mono floats at RATE, streamed from YouTube via ffmpeg. */
function audio(videoId) {
  return new Promise((resolve, reject) => {
    const dl = spawn('yt-dlp', ['-f', 'bestaudio', '-o', '-', '--quiet', '--no-warnings', `https://www.youtube.com/watch?v=${videoId}`]);
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1']);
    dl.stdout.pipe(ff.stdin);
    dl.on('error', reject);
    ff.on('error', reject);
    ff.stdin.on('error', () => {});
    const chunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (code !== 0 || buf.length < RATE * 4 * 5) return reject(new Error(`no audio (ffmpeg ${code})`));
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

/** An RBJ biquad, run over the whole song. */
function biquad(x, type, freq, q) {
  const w = (2 * Math.PI * freq) / RATE;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'lowpass') [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
  else if (type === 'highpass') [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  else [b0, b1, b2] = [alpha, 0, -alpha];
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** Loudness per frame in dB, at `hop` samples per frame. */
function loudness(x, hop) {
  const n = Math.floor(x.length / hop);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) s += x[j] * x[j];
    out[i] = 20 * Math.log10(Math.sqrt(s / hop) + 1e-9);
  }
  return out;
}

/** dB per frame to 0–255: the song's quiet floor to its loud ceiling. */
function bytes(db) {
  const sorted = Float32Array.from(db).sort();
  const lo = sorted[Math.floor(sorted.length * 0.1)];
  const hi = sorted[Math.floor(sorted.length * 0.99)];
  const out = new Uint8Array(db.length);
  for (let i = 0; i < db.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(((db[i] - lo) / Math.max(1, hi - lo)) * 255)));
  return out;
}

/** The tempo, from the kick and snare's onsets at about 100 frames a second. */
function tempo(lo, mid) {
  // Whole-sample windows (220 samples, about 100 a second): a fractional
  // window read between samples and made every score NaN, so the tempo stuck
  // at its default.
  const hop = Math.round(RATE / 100);
  const fps = RATE / hop;
  const a = loudness(lo, hop);
  const b = loudness(mid, hop);
  const on = new Float32Array(a.length);
  for (let i = 1; i < a.length; i++) on[i] = Math.max(0, a[i] - a[i - 1]) + 0.7 * Math.max(0, b[i] - b[i - 1]);
  let best = 120;
  let score = -Infinity;
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const lag = (60 / bpm) * fps;
    let s = 0;
    for (let i = 0; i + 2 * lag < on.length; i += 2) s += on[i] * (on[Math.round(i + lag)] + 0.5 * on[Math.round(i + 2 * lag)]);
    s *= 1 - Math.min(0.25, Math.abs(bpm - 118) / 400);
    if (s > score) [score, best] = [s, bpm];
  }
  return best;
}

async function analyse(videoId) {
  // YouTube sometimes drops a stream; one more try usually gets it.
  const x = await audio(videoId).catch(() => new Promise((r) => setTimeout(r, 2000)).then(() => audio(videoId)));
  const lo = biquad(x, 'lowpass', 150, 0.8);
  const mid = biquad(x, 'bandpass', 1800, 0.9);
  const hi = biquad(x, 'highpass', 7000, 0.8);
  const b64 = (u8) => Buffer.from(u8).toString('base64');
  return {
    v: 1,
    videoId,
    fps: FPS,
    duration: Math.round((x.length / RATE) * 10) / 10,
    bpm: tempo(lo, mid),
    low: b64(bytes(loudness(lo, HOP))),
    mid: b64(bytes(loudness(mid, HOP))),
    high: b64(bytes(loudness(hi, HOP))),
  };
}

// ---- The run ----------------------------------------------------------------------

// --test <videoId>: analyse one video and print its tempo and size, writing nothing.
if (process.argv.includes('--test')) {
  const id = process.argv[process.argv.indexOf('--test') + 1];
  const t0 = Date.now();
  const t = await analyse(id);
  console.log(`${id}: ${t.bpm} bpm, ${t.duration}s, ${(JSON.stringify(t).length / 1024).toFixed(1)} KB, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

await mkdir('data/v', { recursive: true });
const tracksFile = 'data/tracks.json';
const tracks = (await exists(tracksFile)) ? JSON.parse(await readFile(tracksFile, 'utf8')) : {};

const station = await json(`${SITE}/api/radio/station?id=site`);
const jobs = [];
for (const t of station.tracks ?? []) jobs.push({ kind: 'track', track: t });
// Visitors' songs, by the videos they sent.
for (const url of [`${SITE}/api/jukebox`, `${SITE}/api/guestbook`]) {
  try {
    const d = await json(url);
    for (const s of d.songs ?? []) if (s.videoId) jobs.push({ kind: 'video', videoId: s.videoId, label: s.title });
    for (const e of d.entries ?? []) if (e.song?.videoId) jobs.push({ kind: 'video', videoId: e.song.videoId, label: e.song.title });
  } catch {
    // Not every site has both lists.
  }
}

let done = 0;
let made = 0;
const todo = [];
for (const j of jobs) {
  const id = j.kind === 'track' ? tracks[j.track.id] : j.videoId;
  if (id && (await exists(`data/v/${id}.json`))) continue;
  todo.push(j);
}
console.log(`${jobs.length} songs, ${todo.length} without a timeline${LIMIT < Infinity ? `; doing ${Math.min(LIMIT, todo.length)}` : ''}.`);

const queue = todo.slice(0, LIMIT);
async function worker() {
  while (queue.length) {
    const j = queue.shift();
    const label = j.kind === 'track' ? `${j.track.artists.split(',')[0]} - ${j.track.title}` : j.label ?? j.videoId;
    try {
      const videoId = j.kind === 'track' ? (tracks[j.track.id] ?? (await pick(j.track))) : j.videoId;
      if (!videoId) {
        console.log(`  skip   ${label} (no matching recording)`);
        continue;
      }
      const t = await analyse(videoId);
      await writeFile(`data/v/${videoId}.json`, JSON.stringify(t));
      if (j.kind === 'track') tracks[j.track.id] = videoId;
      made++;
      console.log(`  ok     ${label} (${videoId}, ${t.bpm} bpm, ${t.duration}s)`);
    } catch (err) {
      console.log(`  fail   ${label}: ${err instanceof Error ? err.message : err}`);
    } finally {
      done++;
      if (done % 10 === 0) await writeFile(tracksFile, JSON.stringify(tracks, null, 1));
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await writeFile(tracksFile, JSON.stringify(tracks, null, 1));
console.log(`Made ${made} timeline${made === 1 ? '' : 's'}.`);
