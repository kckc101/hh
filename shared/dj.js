// Shared DJ / playlist state machine.
// Used by the Socket.io server (authoritative) and by the client in offline demo mode,
// so playback logic behaves identically in both.

export const SYNTH_BARS = 96;

// Built-in procedural tracks. Every client renders these deterministically from the seed,
// so the whole crowd hears the same music, position-synced to the server clock.
export const SYNTH_PRESETS = [
  { id: 'angkor-sunrise', title: 'Angkor Sunrise', artist: 'E-Rave Residents', bpm: 124, seed: 1107, style: 'house', key: 3 },
  { id: 'mekong-bass', title: 'Mekong Bassline', artist: 'DJ Kroma', bpm: 128, seed: 2291, style: 'techno', key: 0 },
  { id: 'apsara-acid', title: 'Apsara Acid', artist: 'Neon Naga', bpm: 132, seed: 3373, style: 'acid', key: 5 },
  { id: 'tuktuk-turbo', title: 'Tuk-Tuk Turbo', artist: 'Phnom Penh Underground', bpm: 140, seed: 4421, style: 'trance', key: 2 },
  { id: 'penh-nights', title: 'Phnom Penh Nights', artist: 'Riverside Collective', bpm: 122, seed: 5953, style: 'deep', key: 7 },
];

export const TRACK_TYPES = ['synth', 'url', 'stream', 'youtube', 'soundcloud'];
export const FX_TYPES = ['fire', 'co2', 'smoke', 'blackout', 'lasers', 'confetti', 'fireworks', 'hype'];

export function synthDuration(bpm) {
  return (SYNTH_BARS * 4 * 60) / bpm;
}

export function presetById(id) {
  return SYNTH_PRESETS.find((p) => p.id === id) || null;
}

let uidCounter = 0;
export function makeUid() {
  uidCounter = (uidCounter + 1) % 1e6;
  return Math.random().toString(36).slice(2, 8) + uidCounter.toString(36);
}

export function synthTrack(presetId) {
  const p = presetById(presetId) || SYNTH_PRESETS[0];
  return {
    uid: makeUid(),
    type: 'synth',
    preset: p.id,
    title: p.title,
    artist: p.artist,
    bpm: p.bpm,
    duration: synthDuration(p.bpm),
  };
}

const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);

/** Validates an incoming track description. Returns a clean track (with a fresh uid) or null. */
export function sanitizeTrack(t) {
  if (!t || typeof t !== 'object' || !TRACK_TYPES.includes(t.type)) return null;
  if (t.type === 'synth') {
    return presetById(t.preset) ? synthTrack(t.preset) : null;
  }
  const src = clip(t.src, 600);
  const okSrc = /^https?:\/\//i.test(src) || /^\/uploads\/[\w.-]+$/.test(src) || /^blob:/.test(src);
  if (!okSrc) return null;
  const bpm = Number(t.bpm);
  return {
    uid: makeUid(),
    type: t.type,
    src,
    title: clip(t.title, 80) || 'Untitled track',
    artist: clip(t.artist, 60) || 'Guest Selector',
    bpm: Number.isFinite(bpm) && bpm >= 60 && bpm <= 200 ? Math.round(bpm) : null,
    duration: null,
  };
}

export class DJController {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.queue = SYNTH_PRESETS.map((p) => synthTrack(p.id));
    this.index = 0;
    this.playing = true;
    this.startedAt = now();
    this.pausedPos = 0;
    this.bpm = 128; // manual tempo used for sources that can't be analysed (YouTube/SoundCloud)
  }

  get current() {
    return this.queue[this.index] || null;
  }

  position() {
    return this.playing ? (this.now() - this.startedAt) / 1000 : this.pausedPos;
  }

  snapshot() {
    return {
      queue: this.queue,
      index: this.index,
      playing: this.playing,
      startedAt: this.startedAt,
      pausedPos: this.pausedPos,
      bpm: this.bpm,
    };
  }

  play(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.queue.length) return false;
    this.index = index;
    this.startedAt = this.now();
    this.pausedPos = 0;
    this.playing = true;
    return true;
  }

  pause() {
    if (!this.playing) return false;
    this.pausedPos = this.position();
    this.playing = false;
    return true;
  }

  resume() {
    if (this.playing || !this.current) return false;
    this.startedAt = this.now() - this.pausedPos * 1000;
    this.playing = true;
    return true;
  }

  next() {
    if (!this.queue.length) return false;
    return this.play((this.index + 1) % this.queue.length);
  }

  prev() {
    if (!this.queue.length) return false;
    return this.play((this.index - 1 + this.queue.length) % this.queue.length);
  }

  add(track) {
    const t = sanitizeTrack(track);
    if (!t || this.queue.length >= 60) return false;
    this.queue.push(t);
    if (this.queue.length === 1) this.play(0);
    return true;
  }

  remove(uid) {
    const i = this.queue.findIndex((t) => t.uid === uid);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    if (i < this.index) {
      this.index--;
    } else if (i === this.index) {
      if (this.index >= this.queue.length) this.index = 0;
      this.startedAt = this.now();
      this.pausedPos = 0;
    }
    return true;
  }

  move(uid, dir) {
    const i = this.queue.findIndex((t) => t.uid === uid);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= this.queue.length) return false;
    [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    if (this.index === i) this.index = j;
    else if (this.index === j) this.index = i;
    return true;
  }

  setBpm(bpm) {
    const b = Math.round(Number(bpm));
    if (!Number.isFinite(b) || b < 60 || b > 200) return false;
    this.bpm = b;
    return true;
  }

  /** A client reports that the current track finished (for tracks whose duration only the browser knows). */
  reportEnded(uid) {
    const cur = this.current;
    if (!cur || cur.uid !== uid || !this.playing || this.position() < 5) return false;
    return this.next();
  }

  /** Auto-advance tracks with a known duration. Returns true when state changed. */
  tick() {
    const cur = this.current;
    if (!cur || !this.playing || !cur.duration) return false;
    if (this.position() > cur.duration + 0.4) return this.next();
    return false;
  }

  apply(action, arg) {
    switch (action) {
      case 'play': return this.play(Number(arg));
      case 'pause': return this.pause();
      case 'resume': return this.resume();
      case 'toggle': return this.playing ? this.pause() : this.resume();
      case 'next': return this.next();
      case 'prev': return this.prev();
      case 'add': return this.add(arg);
      case 'remove': return this.remove(String(arg));
      case 'move': return this.move(String(arg?.uid), Number(arg?.dir));
      case 'bpm': return this.setBpm(arg);
      default: return false;
    }
  }
}
