// Members area: sign-in (Supabase email + password), parts library, score display
// (OpenSheetMusicDisplay) and simple playback (Web Audio).

const $ = id => document.getElementById(id);
const VIEWS = ["login-view", "message-view", "library-view"];
let member = null;    // row from the members table
let osmd = null;
let current = null;   // { piece, part }
let playback = null;  // { ctx, timers }
const partCache = new Map();

function show(view) {
  for (const v of VIEWS) $(v).hidden = v !== view;
}

function showMessage(title, text, canSignOut = false) {
  $("message-title").textContent = title;
  $("message-text").textContent = text;
  $("message-logout").hidden = !canSignOut;
  show("message-view");
}

// ---------- Sign-in ----------

// Arriving from a "reset your password" email: ask for the new password before anything else.
let recovering = /type=recovery/.test(location.hash);
const backToSite = () => location.origin + location.pathname;

// New accounts are set up on signup.html, which first checks the librarian has added the email.
const AUTH_FORMS = {
  "signin-form": "Sign in",
  "forgot-form": "Reset your password",
  "newpass-form": "Choose a new password",
};

function linkButton(form, text) {
  const button = el("button", { type: "button", className: "link-btn", textContent: text });
  button.dataset.show = form;
  return button;
}

function showAuth(form, notice = "") {
  for (const f of Object.keys(AUTH_FORMS)) $(f).hidden = f !== form;
  $("auth-title").textContent = AUTH_FORMS[form];
  $("auth-error").textContent = "";
  $("auth-notice").textContent = notice;
  $("auth-notice").hidden = !notice;
  if (form === "signin-form") $("auth-switch").replaceChildren("New member? ", el("a", { href: "signup.html", textContent: "Set up your account" }));
  else if (form === "newpass-form") $("auth-switch").replaceChildren(member ? linkButton("library", "Cancel") : "");
  else $("auth-switch").replaceChildren(linkButton("signin-form", "Back to sign in"));
  show("login-view");
}

document.addEventListener("click", e => {
  const target = e.target.closest("[data-show]");
  if (!target) return;
  if (target.dataset.show === "library") show("library-view");
  else showAuth(target.dataset.show);
});

// Runs a form's Supabase call with the button disabled; shows the error if there is one.
async function submitAuth(form, action) {
  const button = form.querySelector("button[type=submit]");
  $("auth-error").textContent = "";
  button.disabled = true;
  try { await action(form); }
  catch (err) {
    $("auth-error").textContent = /rate limit/i.test(err.message)
      ? "Too many emails have been sent in the last hour. Please try again a bit later."
      : err.message;
  }
  finally { button.disabled = false; }
}

function checkPasswords(form) {
  if (form.password.value !== form.confirm.value) throw new Error("The two passwords don't match.");
}

$("signin-form").addEventListener("submit", e => {
  e.preventDefault();
  submitAuth(e.target, async f => {
    const { error } = await sb.auth.signInWithPassword({
      email: f.email.value.trim().toLowerCase(), password: f.password.value,
    });
    if (!error) { f.reset(); return; }  // the auth listener opens the library
    if (/not confirmed/i.test(error.message)) {
      throw new Error("Please confirm your email first: click the link in the email we sent when you created your account.");
    }
    if (/invalid login/i.test(error.message)) {
      throw new Error("That email and password don't match. New member? Set up your account below. Forgotten your password? Reset it below.");
    }
    throw error;
  });
});

$("forgot-form").addEventListener("submit", e => {
  e.preventDefault();
  submitAuth(e.target, async f => {
    const email = f.email.value.trim().toLowerCase();
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: backToSite() });
    if (error) throw error;
    f.reset();
    showAuth("signin-form", `If ${email} has an account, we've sent it a link to choose a new password.`);
  });
});

$("newpass-form").addEventListener("submit", e => {
  e.preventDefault();
  submitAuth(e.target, async f => {
    checkPasswords(f);
    const { error } = await sb.auth.updateUser({ password: f.password.value });
    if (error) throw error;
    f.reset();
    recovering = false;
    const { data: { session } } = await sb.auth.getSession();
    if (member) show("library-view");
    else onSession(session);
  });
});

async function start() {
  if (!sb) {
    showMessage("Not connected yet", "This site hasn't been connected to Supabase. Add your project details to config.js (see SETUP.md).");
    return;
  }
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") recovering = true;
    // Run outside the auth callback so Supabase calls inside don't deadlock.
    if (["INITIAL_SESSION", "SIGNED_IN", "SIGNED_OUT", "PASSWORD_RECOVERY"].includes(event)) {
      setTimeout(() => onSession(session), 0);
    }
  });
}

async function onSession(session) {
  if (!session) { member = null; showAuth("signin-form"); return; }
  if (recovering) { showAuth("newpass-form"); return; }
  if (member) return;  // already showing the library
  const email = session.user.email.toLowerCase();
  const { data, error } = await sb.from("members").select("*").eq("email", email).maybeSingle();
  if (error) { showMessage("Something went wrong", error.message, true); return; }
  if (!data) {
    showMessage("Not on the members list yet",
      `You're signed in as ${email}, but that email isn't on the members list. Please ask the orchestra librarian to add you.`, true);
    return;
  }
  member = data;
  show("library-view");
  openLibrary();
}

async function signOut() {
  stop();
  await sb.auth.signOut();
  location.reload();
}
$("logout").addEventListener("click", signOut);
$("message-logout").addEventListener("click", signOut);

// ---------- Library ----------

// A member's "Flute" matches the parts "Flute", "Flute 1" and "Flute 2".
const baseInstrument = s => s.trim().toLowerCase().replace(/\s+\d+$/, "");
const sameInstrument = (part, mine) => baseInstrument(part) === baseInstrument(mine);

async function openLibrary() {
  $("welcome").textContent = `Welcome, ${member.name}`;
  $("admin-link").hidden = !member.is_admin;

  const { data: pieces, error } = await sb.from("pieces")
    .select("id, title, composer, concert, parts(id, instrument, file_path)")
    .order("created_at");
  const list = $("piece-list");
  list.replaceChildren();
  if (error) { list.append(el("p", { className: "error", textContent: error.message })); return; }
  if (!pieces.length) { list.append(el("p", { className: "muted", textContent: "No music has been added yet." })); return; }

  let mine = null;
  for (const piece of pieces) {
    const div = el("div", { className: "piece" },
      el("h3", { textContent: piece.title }),
      el("small", { textContent: [piece.composer, piece.concert].filter(Boolean).join(" · ") }));
    // Put the member's own part first.
    const isMine = p => sameInstrument(p.instrument, member.instrument);
    const parts = [...piece.parts].sort((a, b) => isMine(b) - isMine(a) || a.instrument.localeCompare(b.instrument));
    for (const part of parts) {
      const btn = el("button", { className: "part-btn", type: "button" },
        el("span", { textContent: part.instrument }),
        isMine(part) && el("span", { className: "tag need", textContent: "Your part" }));
      if (isMine(part)) mine ??= { piece, part, btn };
      btn.addEventListener("click", () => selectPart(piece, part, btn));
      div.append(btn);
    }
    list.append(div);
  }
  if (mine) selectPart(mine.piece, mine.part, mine.btn);
}

async function loadPart(path) {
  if (!partCache.has(path)) {
    const { data, error } = await sb.storage.from("music").download(path);
    if (error) throw error;
    partCache.set(path, await data.text());
  }
  return partCache.get(path);
}

async function selectPart(piece, part, btn) {
  stop();
  document.querySelectorAll(".part-btn").forEach(b => b.classList.toggle("active", b === btn));
  current = { piece, part };
  $("viewer-title").textContent = `${piece.title} — ${part.instrument}`;
  $("viewer-sub").textContent = piece.composer;
  $("downloads").hidden = false;
  $("controls").hidden = false;
  $("score").replaceChildren(el("p", { className: "muted", textContent: "Loading music…" }));

  let xml;
  try {
    xml = await loadPart(part.file_path);
  } catch (err) {
    $("score").replaceChildren(el("p", { className: "error", textContent: `Couldn't load this part: ${err.message}` }));
    return;
  }
  if (current?.part !== part) return;  // another part was picked meanwhile
  const { tempo, measures } = parseMusicXML(xml);
  $("tempo").value = tempo;
  $("tempo-val").textContent = tempo;
  current.bars = { first: measures[0]?.label ?? 1, last: measures.at(-1)?.label ?? 1 };
  wholePiece();

  $("score").replaceChildren();
  osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay($("score"), {
    autoResize: true, drawTitle: false, drawPartNames: false, followCursor: true,
  });
  try {
    // The score display only accepts text that starts with the <?xml?> declaration;
    // parts split from a full score before this was fixed don't have it.
    await osmd.load(withDeclaration(xml));
    useLibraryDetails(osmd, piece, part);
    osmd.render();
  } catch (err) {
    osmd = null;
    $("score").replaceChildren(el("p", { className: "error",
      textContent: `The music couldn't be displayed (${err.message}). Playback and download still work.` }));
  }
}

// The score display only accepts text that starts with the <?xml?> declaration;
// parts split from a full score before that was fixed don't have it.
function withDeclaration(xml) {
  const text = xml.replace(/^﻿?\s*/, "");
  return text.startsWith("<?xml") ? text : `<?xml version="1.0" encoding="UTF-8"?>\n${text}`;
}

// Show the title and composer from the library, not whatever the file says
// (MuseScore leaves "Untitled score" and "Composer / arranger" if they weren't filled in).
// Also numbers bars only at the start of each line, as printed parts do.
function useLibraryDetails(display, piece, part) {
  display.Sheet.TitleString = piece.title;
  display.Sheet.SubtitleString = part.instrument;
  display.Sheet.ComposerString = piece.composer || "";
  display.EngravingRules.RenderMeasureNumbersOnlyAtSystemStart = true;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    document.head.append(el("script", { src, onload: resolve, onerror: () => reject(new Error(`Couldn't load ${src}`)) }));
  });
}

// Lays the part out on A4 pages (with title, instrument and composer) and saves it as a PDF.
$("download-pdf").addEventListener("click", async () => {
  if (!current) return;
  const { piece, part } = current;
  const button = $("download-pdf");
  button.disabled = true;
  button.textContent = "Making PDF…";
  const box = el("div", { className: "pdf-render" });
  document.body.append(box);
  try {
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
    await loadScript("https://cdn.jsdelivr.net/npm/svg2pdf.js@2.2.3/dist/svg2pdf.umd.min.js");
    const pageView = new opensheetmusicdisplay.OpenSheetMusicDisplay(box, {
      autoResize: false, backend: "svg", pageFormat: "A4_P", pageBackgroundColor: "#FFFFFF",
      drawTitle: true, drawSubtitle: true, drawComposer: true, drawPartNames: false,
      drawMetronomeMarks: false,  // their "= 100" text doesn't survive the PDF conversion
    });
    await pageView.load(withDeclaration(await loadPart(part.file_path)));
    useLibraryDetails(pageView, piece, part);
    pageView.render();

    const pdf = new window.jspdf.jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pages = [...box.querySelectorAll("svg")];
    for (const [i, svg] of pages.entries()) {
      if (i > 0) pdf.addPage("a4", "portrait");
      await pdf.svg(svg, { x: 0, y: 0, width: 210, height: 297 });
    }
    pdf.save(`${piece.title} - ${part.instrument}.pdf`);
  } catch (err) {
    alert(`Sorry, the PDF couldn't be made: ${err.message}`);
  } finally {
    box.remove();
    button.disabled = false;
    button.textContent = "Download PDF";
  }
});

$("download").addEventListener("click", async () => {
  if (!current) return;
  const name = `${current.piece.title} - ${current.part.instrument}.musicxml`;
  const { data, error } = await sb.storage.from("music").createSignedUrl(current.part.file_path, 60, { download: name });
  if (error) { alert(error.message); return; }
  location.href = data.signedUrl;
});

// ---------- Playback ----------

const STEPS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Reads notes from a single-part MusicXML file. Times are in quarter notes.
function parseMusicXML(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  let divisions = 1, tempo = null, t = 0, lastStart = 0, simple = true, time = null, transpose = 0;
  const notes = [];
  const measures = [];  // { label, start, end } per bar, for practising a section
  const openTies = new Map();  // voice:pitch -> the note a tie is still holding on
  for (const measure of doc.querySelectorAll("part > measure")) {
    const measureStart = t;
    let measureEnd = t;
    for (const node of measure.children) {
      if (node.tagName === "attributes") {
        const d = node.querySelector("divisions");
        if (d) divisions = +d.textContent;
        const beats = node.querySelector("time > beats"), beatType = node.querySelector("time > beat-type");
        if (beats && beatType && !time) time = { beats: parseInt(beats.textContent, 10) || 4, beatType: +beatType.textContent || 4 };
        // Transposing instruments (clarinet, horn, trumpet…) are written at a different pitch from how they sound.
        const tr = node.querySelector("transpose");
        if (tr) transpose = +(tr.querySelector("chromatic")?.textContent ?? 0) + 12 * +(tr.querySelector("octave-change")?.textContent ?? 0);
      } else if (node.tagName === "direction" || node.tagName === "sound") {
        const s = node.tagName === "sound" ? node : node.querySelector("sound");
        if (s?.getAttribute("tempo") && tempo === null) tempo = Math.round(+s.getAttribute("tempo"));
      } else if (node.tagName === "backup" || node.tagName === "forward") {
        const d = +node.querySelector("duration").textContent / divisions;
        t += node.tagName === "backup" ? -d : d;
        simple = false;
      } else if (node.tagName === "note" && !node.querySelector("grace")) {
        const dur = +(node.querySelector("duration")?.textContent ?? 0) / divisions;
        const chord = !!node.querySelector("chord");
        const start = chord ? lastStart : t;
        if (!chord) { lastStart = t; t += dur; }
        const p = node.querySelector("pitch");
        const midi = p ? 12 * (+p.querySelector("octave").textContent + 1)
          + STEPS[p.querySelector("step").textContent] + +(p.querySelector("alter")?.textContent ?? 0) + transpose : null;
        const note = { start, dur, midi, chord };
        // A tied note is one sound: lengthen the note it continues instead of playing it
        // again. It stays in the list (silent) so the score cursor still steps onto it.
        const key = `${node.querySelector("voice")?.textContent ?? 1}:${midi}`;
        const held = midi !== null && node.querySelector(':scope > tie[type="stop"]') ? openTies.get(key) : null;
        if (held) {
          held.dur = start + dur - held.start;
          note.tied = true;
        }
        if (midi !== null && node.querySelector(':scope > tie[type="start"]')) openTies.set(key, held ?? note);
        else openTies.delete(key);
        notes.push(note);
      }
      measureEnd = Math.max(measureEnd, t);
    }
    // Several voices in one bar step back and forth in time; the bar ends at the furthest point.
    t = measureEnd;
    const label = parseInt(measure.getAttribute("number"), 10);
    measures.push({ label: Number.isFinite(label) ? label : measures.length + 1, start: measureStart, end: measureEnd });
  }
  return { notes, measures, tempo: tempo ?? 100, simple, time: time ?? { beats: 4, beatType: 4 } };
}

// Slider position (0–100) to gain; squared so the slider feels even to the ear.
const sliderGain = (id, max = 1) => (+$(id).value / 100) ** 2 * max;
const OTHERS_MAX = 0.6;  // the rest of the orchestra is several parts at once

function scheduleNotes(ctx, notes, secPerBeat, volume, startAt, destination) {
  for (const n of notes) {
    if (n.midi === null || n.tied) continue;
    const freq = 440 * 2 ** ((n.midi - 69) / 12);
    const on = startAt + n.start * secPerBeat;
    const off = on + n.dur * secPerBeat * 0.95;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, on);
    gain.gain.linearRampToValueAtTime(volume, on + 0.02);
    gain.gain.setValueAtTime(volume, off - 0.05);
    gain.gain.linearRampToValueAtTime(0, off);
    osc.connect(gain).connect(destination);
    osc.start(on);
    osc.stop(off + 0.01);
  }
}

// Metronome clicks from `from` to `end` seconds, with a higher click on the first beat of each bar.
function scheduleClicks(ctx, time, secPerBeat, from, end, destination) {
  const beatSec = secPerBeat * 4 / time.beatType;
  for (let i = 0, at = from; at < end - 0.01; i++, at += beatSec) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = i % time.beats === 0 ? 1600 : 1100;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.5, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    osc.connect(gain).connect(destination);
    osc.start(at);
    osc.stop(at + 0.06);
  }
}

// ---------- Practice section ----------

function wholePiece() {
  if (!current?.bars) return;
  for (const id of ["from-bar", "to-bar"]) {
    $(id).min = current.bars.first;
    $(id).max = current.bars.last;
  }
  $("from-bar").value = current.bars.first;
  $("to-bar").value = current.bars.last;
}

// Keeps the bar numbers inside the piece, with "from" never after "to".
function tidyBars(changed) {
  if (!current?.bars) return;
  const clamp = v => Math.min(Math.max(parseInt(v, 10) || current.bars.first, current.bars.first), current.bars.last);
  let from = clamp($("from-bar").value), to = clamp($("to-bar").value);
  if (from > to) { if (changed === "from-bar") to = from; else from = to; }
  $("from-bar").value = from;
  $("to-bar").value = to;
}

// The chosen bars as a time span (in quarter notes) of the given part.
function sectionSpan(measures) {
  const from = +$("from-bar").value, to = +$("to-bar").value;
  const first = measures.find(m => m.label >= from) ?? measures[0];
  const last = [...measures].reverse().find(m => m.label <= to) ?? measures.at(-1);
  return { from: first.start, to: Math.max(last.end, first.end) };
}

// Just the notes inside the span, moved so the span starts at time 0.
function notesIn(notes, span) {
  const eps = 1e-6;
  return notes
    .filter(n => n.start >= span.from - eps && n.start < span.to - eps)
    .map(n => ({
      ...n,
      start: n.start - span.from,
      dur: Math.min(n.dur, span.to - n.start),
      // A note tied over from before the section still needs to sound when the section starts.
      tied: n.tied && n.start > span.from + eps,
    }));
}

$("whole-piece").addEventListener("click", wholePiece);

// Phones: the control bar is folded to Play and Tempo until "More options" is tapped.
$("more-controls").addEventListener("click", e => {
  const open = $("controls").classList.toggle("expanded");
  e.target.textContent = open ? "Fewer options" : "More options";
  e.target.setAttribute("aria-expanded", open);
});
$("from-bar").addEventListener("change", () => tidyBars("from-bar"));
$("to-bar").addEventListener("change", () => tidyBars("to-bar"));

// ---------- Playing ----------

// `repeat` is set when Loop starts the section again. That round reuses the audio player
// that's already running: browsers only let sound start right after a click, so a new
// player created by the loop on its own would be silent.
async function play({ repeat = false } = {}) {
  if (!current) return;
  const previous = repeat ? playback : null;
  if (previous) previous.timers.forEach(clearTimeout);
  else stop();
  const mine = current.part.file_path;
  // Every part is scheduled, so the volume sliders can bring the others in or out mid-play.
  const paths = current.piece.parts.map(p => p.file_path);
  let texts;
  try {
    texts = await Promise.all(paths.map(loadPart));
  } catch (err) {
    alert(`Couldn't load the music: ${err.message}`);
    return;
  }
  const parsed = paths.map((path, i) => ({ path, ...parseMusicXML(texts[i]) }));
  const main = parsed.find(p => p.path === mine);
  const span = sectionSpan(main.measures);
  const parts = parsed.map(p => ({ ...p, notes: notesIn(p.notes, span) }));
  const mainNotes = parts.find(p => p.path === mine).notes;

  const secPerBeat = 60 / +$("tempo").value;
  if (repeat && playback !== previous) return;  // stopped while the music was loading
  const ctx = previous?.ctx ?? new AudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  let groups = previous?.groups;
  if (!groups) {
    groups = {
      mine: ctx.createGain(),
      others: ctx.createGain(),
      clicks: ctx.createGain(),
      countIn: ctx.createGain(),
    };
    groups.mine.gain.value = sliderGain("vol-mine");
    groups.others.gain.value = sliderGain("vol-others", OTHERS_MAX);
    groups.clicks.gain.value = $("metronome").checked ? 1 : 0;
    Object.values(groups).forEach(g => g.connect(ctx.destination));
  }

  // Count-in: bars of clicks (always heard) before the music starts, with the beat
  // number shown on screen, so the player has time to get their instrument up.
  const beatSec = secPerBeat * 4 / main.time.beatType;
  const countBeats = +$("countin").value * main.time.beats;  // before every round, loops too
  const clickFrom = ctx.currentTime + 0.15;
  const startAt = clickFrom + countBeats * beatSec;
  playback = { ctx, timers: [], groups };
  $("play").textContent = "■ Stop";

  const end = span.to - span.from;
  for (const part of parts) {
    scheduleNotes(ctx, part.notes, secPerBeat, 0.22, startAt, part.path === mine ? groups.mine : groups.others);
  }
  scheduleClicks(ctx, main.time, secPerBeat, clickFrom, startAt, groups.countIn);
  scheduleClicks(ctx, main.time, secPerBeat, startAt, startAt + end * secPerBeat, groups.clicks);

  const untilClicks = (clickFrom - ctx.currentTime) * 1000;
  for (let i = 0; i < countBeats; i++) {
    playback.timers.push(setTimeout(() => { $("count-display").textContent = (i % main.time.beats) + 1; }, untilClicks + i * beatSec * 1000));
  }
  playback.timers.push(setTimeout(() => { $("count-display").textContent = ""; }, (startAt - ctx.currentTime) * 1000));

  // Move the score cursor along with the member's part (single-voice parts only).
  if (osmd && main.simple) {
    osmd.cursor.show();
    osmd.cursor.reset();
    // Step the cursor forward to the first bar of the section (its timestamps are in whole notes).
    const it = osmd.cursor.Iterator;
    while (!it.EndReached && it.currentTimeStamp.RealValue * 4 < span.from - 1e-6) osmd.cursor.next();
    const onsets = mainNotes.filter(n => !n.chord).map(n => n.start);
    const delay = (startAt - ctx.currentTime) * 1000;
    onsets.slice(1).forEach(s => playback.timers.push(setTimeout(() => osmd.cursor.next(), delay + s * secPerBeat * 1000)));
  }
  // At the end of the section: go round again if Loop is ticked, otherwise stop.
  playback.timers.push(setTimeout(() => ($("loop").checked ? play({ repeat: true }) : stop()),
    (startAt - ctx.currentTime + end * secPerBeat) * 1000 + 150));
}

function stop() {
  if (!playback) return;
  playback.timers.forEach(clearTimeout);
  playback.ctx.close();
  playback = null;
  $("play").textContent = "▶ Play";
  $("count-display").textContent = "";
  if (osmd?.cursor) osmd.cursor.hide();
}

$("play").addEventListener("click", () => (playback ? stop() : play()));
$("tempo").addEventListener("input", e => { $("tempo-val").textContent = e.target.value; });

// Volume and metronome changes apply straight away, even while playing.
function setGroup(name, value) {
  if (playback) playback.groups[name].gain.setTargetAtTime(value, playback.ctx.currentTime, 0.03);
}
$("vol-mine").addEventListener("input", () => setGroup("mine", sliderGain("vol-mine")));
$("vol-others").addEventListener("input", () => setGroup("others", sliderGain("vol-others", OTHERS_MAX)));
$("metronome").addEventListener("change", e => setGroup("clicks", e.target.checked ? 1 : 0));

start();
