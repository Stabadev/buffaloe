/* Song Scroller — Karaoke blocks UI
   - Highlight chords by BAR GROUP (ex G:2 + G7:2 highlighted together)
   - Keep lyrics aligned to chord columns from the md
   - IMPORTANT: cross-line "carry" when next line starts with lyrics before first chord:
       * The prefix of next line is "carried" into the last chord of previous line
       * If previous last-chord lyric is non-empty: share duration proportionally (nuuhu then hy)
       * If previous last-chord lyric is empty: treat as half silence + half hy (start at mid-chord)
   - Count-in: no chord highlight, no scroll
*/

const btnLoad = document.getElementById("btnLoad");
const btnStart = document.getElementById("btnStart");
const btnPause = document.getElementById("btnPause");
const btnReset = document.getElementById("btnReset");
const btnTempoMinus = document.getElementById("btnTempoMinus");
const btnTempoPlus = document.getElementById("btnTempoPlus");

const elMeta = document.getElementById("metaLine");
const elTempoStep = document.getElementById("tempoStepVal");
const elBpm = document.getElementById("bpmVal");
const elBeat = document.getElementById("beatVal");

const panel = document.getElementById("songPanel");
const emptyState = document.getElementById("emptyState");

const metroDotsEl = document.getElementById("metroDots");
const metroDotEls = metroDotsEl ? Array.from(metroDotsEl.querySelectorAll(".dot")) : [];

/* Mini HUD */
const hudBpmVal = document.getElementById("hudBpmVal");
const hudCountIn = document.getElementById("hudCountIn");
const hudPause = document.getElementById("hudPause");
const hudReset = document.getElementById("hudReset");

const hudMetroDotsEl = document.getElementById("hudMetroDots");
const hudMetroDotEls = hudMetroDotsEl ? Array.from(hudMetroDotsEl.querySelectorAll(".dot")) : [];

const nowChordBadge = document.getElementById("nowChordBadge");


const state = {
  song: null,
  blocks: [],
  events: [], // { eventIndex, blockIndex, chordIndexInBlock, chordName, startBeat, endBeat, barIndex, dur }
  bpm: 120,
  barBeats: 4,
  tempoStep: 2,

  isRunning: false,
  rafId: null,

  // timing
  startTimeMs: 0,
  startGlobalBeat: 0,

  // pointer
  currentEventIndex: 0,

  // metronome
  lastBeatIndex: -1,
  lastBeatInBar: 1,

  // audio
  audioCtx: null,

  // count-in
  countInBars: 2,
  get countInBeats() { return this.countInBars * this.barBeats; },

  // dom cache
  blockEls: [],

  // cross-line carry map:
  // key: eventIndex of "previous last chord"
  // val: array of { targetBlockIndex, targetPrefixEl, startOffsetBeats, endOffsetBeats }
  // where startOffset/endOffset are inside that event (0..dur)
  carryByEventIndex: new Map(),
};

/* ---------------- Utilities ---------------- */

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function setRunningUi(isRunning) {
  document.body.classList.toggle("is-running", !!isRunning);
}

function fmtMeta(song) {
  if (!song) return "—";
  const bits = [];
  if (song.title) bits.push(song.title);
  if (song.artist) bits.push(song.artist);
  if (song.timeSig) bits.push(song.timeSig);
  if (song.capo) bits.push(`capo ${song.capo}`);
  return bits.join(" • ") || "—";
}

/* ---------------- Audio (metronome click) ---------------- */

function ensureAudio() {
  if (state.audioCtx) return state.audioCtx;
  const AC = window.AudioContext || window.webkitAudioContext;
  state.audioCtx = new AC();
  return state.audioCtx;
}

function metronomeClick(beatInBar) {
  if (!state.isRunning) return;
  const ctx = ensureAudio();

  const o = ctx.createOscillator();
  const g = ctx.createGain();

  const isAccent = (beatInBar === 1);
  o.type = "sine";
  o.frequency.value = isAccent ? 1760 : 880;

  const now = ctx.currentTime;
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.12, now + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);

  o.connect(g);
  g.connect(ctx.destination);

  o.start(now);
  o.stop(now + 0.08);
}

/* ---------------- Parsing song markdown ---------------- */

function parseSimpleFrontmatter(mdText) {
  const out = { meta: {}, body: mdText };
  const trimmed = mdText.trimStart();
  if (!trimmed.startsWith("---")) return out;

  const end = trimmed.indexOf("\n---", 3);
  if (end === -1) return out;

  const head = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + "\n---".length).trimStart();

  const meta = {};
  for (const line of head.split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.+)\s*$/);
    if (!m) continue;
    meta[m[1]] = m[2];
  }
  out.meta = meta;
  out.body = body;
  return out;
}

function parseBlocks(mdBody) {
  const lines = mdBody.split(/\r?\n/);
  const blocks = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "[chords]") {
      const chordsRaw = (lines[i+1] ?? "");
      i += 2;

      let lyricsRaw = "";
      if ((lines[i] ?? "").trim() === "[lyrics]") {
        lyricsRaw = (lines[i+1] ?? "");
        i += 2;
      }

      blocks.push({
        chordsRaw,
        lyricsRaw,
        chordTokens: tokenizeChords(chordsRaw),
        _aligned: null,

        // DOM refs (prefix is index 0, then chord segments are index 1..)
        domChords: [],
        domLyrics: [],
      });
      continue;
    }
    i++;
  }
  return blocks;
}

function tokenizeChords(chordsRaw) {
  const rawTokens = (chordsRaw || "").match(/\S+/g) || [];
  return rawTokens.map(t => {
    const m = t.match(/^(.+?):(\d+(?:\.\d+)?)$/);
    if (m) return { name: m[1], dur: parseFloat(m[2]), raw: t };
    return { name: t, dur: null, raw: t };
  });
}

/* ---------------- Build events timeline ---------------- */

function buildEvents(blocks, barBeats) {
  const events = [];
  let beat = 0;
  let eventIndex = 0;

  blocks.forEach((b, blockIndex) => {
    const tokens = b.chordTokens || [];
    tokens.forEach((tok, chordIndexInBlock) => {
      const dur = (tok.dur != null) ? tok.dur : barBeats;
      const startBeat = beat;
      const endBeat = beat + dur;

      const barIndex = Math.floor(startBeat / barBeats);

      events.push({
        eventIndex,
        blockIndex,
        chordIndexInBlock,
        chordName: tok.name,
        chordNameDisplay: tok.name,
        startBeat,
        endBeat,
        barIndex,
        dur
      });

      beat = endBeat;
      eventIndex++;
    });
  });

  return events;
}

/* ---------------- Render blocks (karaoke aligned) ---------------- */

function buildAlignedSegmentsWithPrefix(chordsRaw, lyricsRaw) {
  const chordTokens = (chordsRaw || "").match(/\S+/g) || [];
  const colStarts = [];

  let cursor = 0;
  for (const tok of chordTokens) {
    const idx = chordsRaw.indexOf(tok, cursor);
    colStarts.push(idx >= 0 ? idx : cursor);
    cursor = (idx >= 0 ? idx + tok.length : cursor + tok.length);
  }

  const firstCol = colStarts.length ? colStarts[0] : 0;
  const baseLen = Math.max(chordsRaw.length, (lyricsRaw || "").length);
  const L = Math.max(baseLen, firstCol);

  const lyricPadded = (lyricsRaw || "").padEnd(L, " ");

  const boundaries = [0, ...colStarts, L];

  const lyricSegs = [];
  for (let k = 0; k < boundaries.length - 1; k++) {
    const a = boundaries[k];
    const b = boundaries[k + 1];
    lyricSegs.push(lyricPadded.slice(a, b));
  }

  const buf = new Array(L).fill(" ");
  for (let i2 = 0; i2 < chordTokens.length; i2++) {
    const tok = chordTokens[i2];
    const start = colStarts[i2] || 0;
    for (let j = 0; j < tok.length && (start + j) < L; j++) {
      buf[start + j] = tok[j];
    }
  }

  const chordSegsRaw = [];
  for (let k = 0; k < boundaries.length - 1; k++) {
    const a = boundaries[k];
    const b = boundaries[k + 1];
    chordSegsRaw.push(buf.slice(a, b).join(""));
  }

  return {
    chordTokens,
    colStarts,
    boundaries,
    lyricPadded,
    lyricSegs,
    chordSegsRaw,
    L
  };
}

function stripDurationsInChordSegment(segText) {
  return segText.replace(/:(\d+(?:\.\d+)?)/g, (m) => " ".repeat(m.length));
}

function setNowChordBadge(text){
  if (!nowChordBadge) return;
  nowChordBadge.textContent = text || "—";
}


function renderSong() {
  panel.innerHTML = "";
  state.blockEls = [];

  if (!state.blocks.length) {
    panel.appendChild(emptyState);
    return;
  }

  const frag = document.createDocumentFragment();

  state.blocks.forEach((b, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "block";
    wrap.dataset.block = String(idx);

    const chordsLine = document.createElement("div");
    chordsLine.className = "line chords";
    const lyricsLine = document.createElement("div");
    lyricsLine.className = "line lyrics";

    const aligned = buildAlignedSegmentsWithPrefix(b.chordsRaw, b.lyricsRaw);
    b._aligned = aligned;

    b.domChords = [];
    b.domLyrics = [];

    aligned.chordSegsRaw.forEach((txt) => {
      const sp = document.createElement("span");
      sp.className = "chseg";
      sp.textContent = stripDurationsInChordSegment(txt);
      chordsLine.appendChild(sp);
      b.domChords.push(sp);
    });

    aligned.lyricSegs.forEach((txt) => {
      const sp = document.createElement("span");
      sp.className = "seg";
      sp.textContent = txt;
      lyricsLine.appendChild(sp);
      b.domLyrics.push(sp);
    });

    wrap.appendChild(chordsLine);
    if ((b.lyricsRaw || "").length) wrap.appendChild(lyricsLine);

    frag.appendChild(wrap);
    state.blockEls.push(wrap);
  });

  panel.appendChild(frag);
}

/* ---------------- Highlight + karaoke fill ---------------- */

function clearAllHighlights() {
  for (const b of state.blocks) {
    for (const el of b.domChords) el.classList.remove("active");
    for (const el of b.domLyrics) {
      el.classList.remove("active");
      el.style.removeProperty("--fill");
    }
  }
  for (const el of state.blockEls) el.classList.remove("current");
}

function scrollBlockIntoView(blockIndex) {
  const el = state.blockEls[blockIndex];
  if (!el) return;

  const panelRect = panel.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();

  const desiredTop = panelRect.top + panelRect.height * 0.30;
  const delta = elRect.top - desiredTop;
  panel.scrollTop += delta;
}

function getBarGroupForEventIndex(evIndex) {
  const ev = state.events[evIndex];
  if (!ev) return { start: evIndex, end: evIndex, barIndex: 0 };
  const barIndex = ev.barIndex;

  let a = evIndex;
  while (a > 0 && state.events[a - 1].barIndex === barIndex) a--;

  let b = evIndex;
  while (b + 1 < state.events.length && state.events[b + 1].barIndex === barIndex) b++;

  return { start: a, end: b, barIndex };
}

/* ---------------- CROSS-LINE CARRY LOGIC ---------------- */

function buildCarryMapAfterRender() {
  state.carryByEventIndex = new Map();
  if (!state.events.length) return;

  // Map last event index per block
  const lastEventIndexByBlock = new Map();
  for (const ev of state.events) lastEventIndexByBlock.set(ev.blockIndex, ev.eventIndex);

  // For each block i (starting at 1), if it has prefix lyrics (domLyrics[0] non-empty)
  // AND its chords line starts later (first chord column > 0), then carry its prefix into previous block's last chord.
  for (let bi = 1; bi < state.blocks.length; bi++) {
    const b = state.blocks[bi];
    if (!b || !b._aligned) continue;

    const firstCol = (b._aligned.colStarts && b._aligned.colStarts.length) ? b._aligned.colStarts[0] : 0;
    if (firstCol <= 0) continue; // no "lyrics before first chord" situation

    const prefixEl = b.domLyrics?.[0];
    if (!prefixEl) continue;
    const prefixText = (prefixEl.textContent || "");
    const prefixTrim = prefixText.trim();
    if (!prefixTrim) continue;

    const prevBlockIndex = bi - 1;
    const prevLastEvIndex = lastEventIndexByBlock.get(prevBlockIndex);
    if (prevLastEvIndex == null) continue;

    const prevEv = state.events[prevLastEvIndex];
    if (!prevEv) continue;

    // previous block last chord lyric segment (index = lastChordIndexInBlock + 1 because prefix at 0)
    const prevBlock = state.blocks[prevBlockIndex];
    const prevLastChordSegIndex = (prevBlock?.chordTokens?.length ? prevBlock.chordTokens.length - 1 : 0) + 1;
    const prevLastLyricEl = prevBlock?.domLyrics?.[prevLastChordSegIndex];

    const prevTextTrim = ((prevLastLyricEl?.textContent || "")).trim();
    const dur = prevEv.dur;

    let startOffset = 0;
    let endOffset = dur;

    if (prevTextTrim.length > 0) {
      // Case 1: "nuuhu" exists under C, "hy" is continuation.
      // Split the duration proportionally so we get nuuhu THEN hy within the chord.
      const lenPrev = prevTextTrim.length;
      const lenHy = prefixTrim.length;
      const total = Math.max(1, lenPrev + lenHy);

      // hy starts after the "prev" portion is done
      startOffset = dur * (lenPrev / total);
      endOffset = dur;
    } else {
      // Case 2: silence under C => "half silence + half hy"
      startOffset = dur * 0.5;
      endOffset = dur;
    }

    const carryItem = {
      targetBlockIndex: bi,
      targetPrefixEl: prefixEl,
      startOffsetBeats: startOffset,
      endOffsetBeats: endOffset
    };

    if (!state.carryByEventIndex.has(prevLastEvIndex)) {
      state.carryByEventIndex.set(prevLastEvIndex, []);
    }
    state.carryByEventIndex.get(prevLastEvIndex).push(carryItem);
  }
}

function applyCarryForEvent(ev, musicalBeat) {
  const items = state.carryByEventIndex.get(ev.eventIndex);
  if (!items || !items.length) return;

  // progress inside this event (0..dur)
  const tInEvent = clamp(musicalBeat - ev.startBeat, 0, ev.dur);

  for (const it of items) {
    const el = it.targetPrefixEl;
    if (!el) continue;

    // show it as part of the flow of this event
    state.blockEls[it.targetBlockIndex]?.classList.add("current");
    el.classList.add("active");

    const denom = Math.max(1e-6, (it.endOffsetBeats - it.startOffsetBeats));
    const fill = clamp((tInEvent - it.startOffsetBeats) / denom, 0, 1);
    el.style.setProperty("--fill", String(fill));
  }
}

/* ---------------- Bar group highlight + fill ---------------- */

function applyBarGroupHighlightAndFill(musicalBeat) {
  const idx = state.currentEventIndex;
  const group = getBarGroupForEventIndex(idx);

  const barStartBeat = group.barIndex * state.barBeats;
  const evs = state.events.slice(group.start, group.end + 1);

  // mark blocks touched
  const blocksTouched = new Set(evs.map(e => e.blockIndex));
  for (const bi of blocksTouched) state.blockEls[bi]?.classList.add("current");

  const tInBar = clamp(musicalBeat - barStartBeat, 0, state.barBeats);

  for (const e of evs) {
    const b = state.blocks[e.blockIndex];
    if (!b) continue;

    // chord segment index is +1 because prefix at 0
    const chordSegIndex = e.chordIndexInBlock + 1;
    const lyricSegIndex = e.chordIndexInBlock + 1;

    b.domChords[chordSegIndex]?.classList.add("active");

    const segEl = b.domLyrics[lyricSegIndex];
    if (segEl) segEl.classList.add("active");

    // local fill within bar for the lyric segment
    const localStart = e.startBeat - barStartBeat;
    const localEnd = e.endBeat - barStartBeat;
    const localFill = clamp((tInBar - localStart) / Math.max(1e-6, (localEnd - localStart)), 0, 1);
    if (segEl) segEl.style.setProperty("--fill", String(localFill));

    // ✅ apply cross-line carry if this event is linked to the next block prefix
    applyCarryForEvent(e, musicalBeat);
  }
}

/* ---------------- Metronome visuals (topbar + HUD) ---------------- */

function resetMetronome() {
  state.lastBeatIndex = -1;
  state.lastBeatInBar = 1;

  for (const list of [metroDotEls, hudMetroDotEls]) {
    for (const el of list) el.classList.remove("on");
    if (list[0]) list[0].classList.add("on");
  }
}

function updateMetronome(globalBeat) {
  const barBeats = state.barBeats || 4;
  const beatIndex = Math.floor(globalBeat);
  const beatInBar = (beatIndex % barBeats) + 1;

  for (const list of [metroDotEls, hudMetroDotEls]) {
    for (let i = 0; i < list.length; i++) {
      const n = i + 1;
      list[i].classList.toggle("accent", n === 1);
    }
  }

  if (beatIndex !== state.lastBeatIndex) {
    state.lastBeatIndex = beatIndex;
    state.lastBeatInBar = beatInBar;

    for (const list of [metroDotEls, hudMetroDotEls]) {
      for (const el of list) el.classList.remove("on");
      const dot = list[beatInBar - 1];
      if (dot) {
        dot.classList.remove("on");
        void dot.offsetWidth;
        dot.classList.add("on");
      }
    }

    metronomeClick(beatInBar);
  }
}

/* ---------------- Tempo changes ---------------- */

function beatsPerSecond() {
  return state.bpm / 60;
}

function getGlobalBeatAt(nowMs) {
  const dt = (nowMs - state.startTimeMs) / 1000;
  return state.startGlobalBeat + dt * beatsPerSecond();
}

function getMusicalBeat(globalBeat) {
  return globalBeat - state.countInBeats;
}

function setTempo(newBpm) {
  const bpm = clamp(Math.round(newBpm), 30, 260);
  if (bpm === state.bpm) return;

  const nowMs = performance.now();
  const currentGlobalBeat = getGlobalBeatAt(nowMs);

  state.bpm = bpm;
  elBpm.textContent = String(state.bpm);
  if (hudBpmVal) hudBpmVal.textContent = String(state.bpm);

  state.startGlobalBeat = currentGlobalBeat;
  state.startTimeMs = nowMs;

  updateMetronome(currentGlobalBeat);
}

function adjustTempo(delta) {
  setTempo(state.bpm + delta);
}

/* ---------------- Core loop ---------------- */

function renderHudCountIn(musicalBeat) {
  if (!hudCountIn) return;
  if (!state.song) { hudCountIn.textContent = ""; return; }

  if (musicalBeat < 0) {
    const beatsLeft = Math.ceil(Math.abs(musicalBeat));
    hudCountIn.textContent = `Count-in: ${beatsLeft} beat${beatsLeft > 1 ? "s" : ""}`;
  } else {
    hudCountIn.textContent = "";
  }
}

function tick() {
  if (!state.isRunning) return;

  const nowMs = performance.now();
  const globalBeat = getGlobalBeatAt(nowMs);
  const musicalBeat = getMusicalBeat(globalBeat);

  elBeat.textContent = musicalBeat.toFixed(2);

  updateMetronome(globalBeat);
  renderHudCountIn(musicalBeat);

  // Count-in: no highlight, no scroll
  if (musicalBeat < 0) {
    clearAllHighlights();

    // ✅ AJOUT 1 : pendant le count-in → aucun accord affiché
    setNowChordBadge("—");

    state.rafId = requestAnimationFrame(tick);
    return;
  }

  // Advance event index
  let idx = state.currentEventIndex;
  while (idx < state.events.length && musicalBeat >= state.events[idx].endBeat) idx++;
  idx = clamp(idx, 0, state.events.length - 1);
  state.currentEventIndex = idx;

  // ✅ AJOUT 2 : accord attendu à cet instant
  setNowChordBadge(
    state.events[state.currentEventIndex]?.chordNameDisplay ||
    state.events[state.currentEventIndex]?.chordName ||
    "—"
  );

  clearAllHighlights();
  applyBarGroupHighlightAndFill(musicalBeat);

  // Scroll to current event's block only
  const ev = state.events[state.currentEventIndex];
  if (ev) scrollBlockIntoView(ev.blockIndex);

  state.rafId = requestAnimationFrame(tick);
}


/* ---------------- Transport controls ---------------- */

async function start() {
  if (!state.song) return;

  try {
    const ctx = ensureAudio();
    if (ctx.state === "suspended") await ctx.resume();
  } catch {}

  state.isRunning = true;
  setRunningUi(true);

  btnStart.disabled = true;
  btnPause.disabled = false;

  // you wanted tempo changes mainly before start; keep disabled while running
  btnTempoMinus.disabled = true;
  btnTempoPlus.disabled = true;

  state.startTimeMs = performance.now();
  state.startGlobalBeat = 0;

  state.currentEventIndex = 0;
  resetMetronome();
  clearAllHighlights();

  if (hudBpmVal) hudBpmVal.textContent = String(state.bpm);

  state.rafId = requestAnimationFrame(tick);
}

function pause() {
  state.isRunning = false;
  setRunningUi(false);

  btnStart.disabled = false;
  btnPause.disabled = true;

  btnTempoMinus.disabled = false;
  btnTempoPlus.disabled = false;

  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
}

function reset() {
  state.isRunning = false;
  setRunningUi(false);

  btnStart.disabled = false;
  btnPause.disabled = true;

  btnTempoMinus.disabled = false;
  btnTempoPlus.disabled = false;

  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;

  state.startTimeMs = performance.now();
  state.startGlobalBeat = 0;
  state.currentEventIndex = 0;
  resetMetronome();
  clearAllHighlights();

  panel.scrollTop = 0;
  if (hudCountIn) hudCountIn.textContent = "";
  setNowChordBadge("—");

}

/* ---------------- Load song ---------------- */

async function loadSong(url = "jimmy.md") {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const text = await res.text();

  const fm = parseSimpleFrontmatter(text);
  const meta = fm.meta || {};
  const body = fm.body || "";

  const song = {
    title: meta.title || "",
    artist: meta.artist || "",
    timeSig: meta.timeSig || meta.timesig || "4/4",
    capo: meta.capo || "",
    bpm: meta.bpm ? parseInt(meta.bpm, 10) : null,
  };

  const m = (song.timeSig || "").match(/^(\d+)\s*\/\s*(\d+)$/);
  const numerator = m ? parseInt(m[1], 10) : 4;
  state.barBeats = isFinite(numerator) ? numerator : 4;

  if (song.bpm && isFinite(song.bpm)) state.bpm = clamp(song.bpm, 30, 260);

  state.song = song;
  state.blocks = parseBlocks(body);

  state.events = buildEvents(state.blocks, state.barBeats);
  state.currentEventIndex = 0;

  elMeta.textContent = fmtMeta(song);
  elBpm.textContent = String(state.bpm);
  if (hudBpmVal) hudBpmVal.textContent = String(state.bpm);

  renderSong();

  // ✅ Build carry links AFTER render (needs DOM elements)
  buildCarryMapAfterRender();

  btnStart.disabled = false;
  btnPause.disabled = true;
  btnReset.disabled = false;

  btnTempoMinus.disabled = false;
  btnTempoPlus.disabled = false;

  reset();
}

/* ---------------- Wiring ---------------- */

btnLoad.addEventListener("click", async () => {
  try {
    await loadSong("jimmy.md");
  } catch (e) {
    console.error(e);
    panel.innerHTML = "";
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = `Erreur de chargement: ${String(e.message || e)}`;
    panel.appendChild(div);
  }
});

btnStart.addEventListener("click", start);
btnPause.addEventListener("click", pause);
btnReset.addEventListener("click", reset);

btnTempoMinus.addEventListener("click", () => adjustTempo(-state.tempoStep));
btnTempoPlus.addEventListener("click", () => adjustTempo(+state.tempoStep));

hudPause.addEventListener("click", pause);
hudReset.addEventListener("click", reset);

// init
elTempoStep.textContent = String(state.tempoStep);
elBpm.textContent = "—";
btnStart.disabled = true;
btnPause.disabled = true;
btnReset.disabled = false;
btnTempoMinus.disabled = true;
btnTempoPlus.disabled = true;

// auto load attempt (optional)
loadSong("jimmy.md").catch(() => {});
