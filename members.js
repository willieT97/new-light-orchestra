// Members area: sign-in (Supabase email + password), parts library, score display
// (OpenSheetMusicDisplay) and simple playback (Web Audio).

const $ = id => document.getElementById(id);

// Notices: the next rehearsal, worked out from today's date.
$("next-rehearsal").textContent = `Next rehearsal ${rehearsalDate(nextRehearsals(1)[0])}, ${REHEARSAL.start}pm`;
const VIEWS = ["login-view", "message-view", "library-view"];
let member = null;    // row from the members table
let osmd = null;
let current = null;   // { piece, part }
let playback = null;  // the round playing now: { ctx, groups, scheduler, frame }
const partCache = new Map();
// The music is drawn a little smaller on screen so more bars fit on each line
// (PDFs and printouts stay full size).
const SCREEN_ZOOM = 0.85;

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
  catch (err) { $("auth-error").textContent = friendlyError(err); }
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

// Parts in orchestral score order (flute first, double bass last), then by name.
function scoreOrder(a, b) {
  const rank = part => {
    const i = INSTRUMENTS.findIndex(name => sameInstrument(part.instrument, name));
    return i < 0 ? INSTRUMENTS.length : i;
  };
  return rank(a) - rank(b) || a.instrument.localeCompare(b.instrument, undefined, { numeric: true });
}

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

  // Just the pieces: choosing one opens the member's own part.
  const buttons = pieces.map(piece => {
    const btn = el("button", { className: "piece-btn", type: "button" },
      el("span", { className: "piece-title", textContent: piece.title }),
      el("small", { textContent: [piece.composer, piece.concert].filter(Boolean).join(" · ") }));
    btn.addEventListener("click", () => openPiece(piece, btn));
    list.append(btn);
    return btn;
  });
  openPiece(pieces[0], buttons[0]);
}

// Players get their own instruments' parts; the musical director and librarians (admins)
// can switch to any part. A player with several parts (Flute 1 and 2, or Violin I and Viola)
// can switch between those.
function openPiece(piece, btn) {
  document.querySelectorAll(".piece-btn").forEach(b => b.classList.toggle("active", b === btn));
  const parts = [...piece.parts].sort(scoreOrder);
  const myInstruments = splitInstruments(member.instrument);
  const mine = parts.filter(p => myInstruments.some(i => sameInstrument(p.instrument, i)));
  const choices = member.is_admin ? (parts.length > 1 ? [FULL_SCORE, ...parts] : parts) : mine;

  if (!choices.length) {
    stop();
    current = null;
    $("viewer-title").textContent = piece.title;
    $("viewer-sub").textContent = piece.composer;
    $("part-picker").hidden = true;
    $("downloads").hidden = true;
    $("controls").hidden = true;
    $("score").replaceChildren(el("p", { className: "muted",
      textContent: `There's no ${instrumentsInWords(member.instrument)} part in this piece. If you think that's a mistake, please ask the librarian.` }));
    return;
  }

  const select = $("part-select");
  select.replaceChildren(...choices.map((p, i) => el("option", { value: i, textContent: p.instrument })));
  select.onchange = () => selectPart(piece, choices[+select.value]);
  $("part-picker").hidden = choices.length < 2;
  const first = mine[0] ?? choices.find(p => !p.full) ?? choices[0];
  select.value = choices.indexOf(first);
  selectPart(piece, first);
}

// The admin-only "Full score" choice: every part of the piece on its own stave.
const FULL_SCORE = { instrument: "Full score", full: true };

// The music for a part, or for the full score (put together from the piece's parts).
async function partXml(piece, part) {
  return part.full ? fullScoreXml(piece) : loadPart(part.file_path);
}

// Stitches a piece's single-part files into one score, in orchestral order, each stave
// named after its instrument. Parts may come from different files, so ids are renumbered.
async function fullScoreXml(piece) {
  const parts = [...piece.parts].sort(scoreOrder);
  const texts = await Promise.all(parts.map(p => loadPart(p.file_path)));
  const docs = texts.map(t => new DOMParser().parseFromString(withDeclaration(t), "application/xml"));
  const sources = docs.map(d => [d.querySelector("part-list > score-part"), d.querySelector("score-partwise > part")]);

  const base = docs[0];  // keeps the first part's title, page layout and so on
  const root = base.documentElement;
  const list = root.querySelector(":scope > part-list");
  list.replaceChildren();
  root.querySelectorAll(":scope > part").forEach(p => p.remove());

  sources.forEach(([scorePart, part], i) => {
    if (!scorePart || !part) return;
    const oldId = scorePart.getAttribute("id"), newId = `P${i + 1}`;
    const sp = base.importNode(scorePart, true), pt = base.importNode(part, true);
    for (const node of [sp, pt, ...sp.querySelectorAll("[id]"), ...pt.querySelectorAll("[id]")]) {
      const id = node.getAttribute("id");
      if (id === oldId) node.setAttribute("id", newId);
      else if (id?.startsWith(`${oldId}-`)) node.setAttribute("id", newId + id.slice(oldId.length));  // e.g. P1-I1
    }
    let name = sp.querySelector("part-name");
    if (!name) sp.prepend(name = base.createElement("part-name"));
    name.textContent = parts[i].instrument;
    list.append(sp);
    root.append(pt);
  });
  return withDeclaration(new XMLSerializer().serializeToString(base));  // adds <?xml?> only if missing
}

async function loadPart(path) {
  if (!partCache.has(path)) {
    const { data, error } = await sb.storage.from("music").download(path);
    if (error) throw error;
    partCache.set(path, await data.text());
  }
  return partCache.get(path);
}

async function selectPart(piece, part) {
  stop();
  current = { piece, part };
  $("viewer-title").textContent = `${piece.title} — ${part.instrument}`;
  $("viewer-sub").textContent = piece.composer;
  $("downloads").hidden = false;
  $("controls").hidden = false;
  $("score").replaceChildren(el("p", { className: "muted", textContent: "Loading music…" }));

  let xml;
  try {
    xml = await partXml(piece, part);
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
    // The page header above already shows the title and composer, so the music shows neither.
    // A full score names each stave down the left.
    autoResize: true, drawTitle: false, drawComposer: false, drawLyricist: false, drawPartNames: Boolean(part.full), followCursor: true,
  });
  try {
    // The score display only accepts text that starts with the <?xml?> declaration;
    // parts split from a full score before this was fixed don't have it.
    await osmd.load(withDeclaration(xml));
    useLibraryDetails(osmd, piece, part);
    osmd.zoom = SCREEN_ZOOM;
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
// Also numbers bars only at the start of each line, as printed parts do, and lets slurs steer
// around other markings (tenuto lines, accents) instead of running through them.
function useLibraryDetails(display, piece, part) {
  const sheet = display.Sheet;
  sheet.TitleString = piece.title;
  sheet.SubtitleString = part.instrument;
  sheet.ComposerString = piece.composer || "";
  display.EngravingRules.RenderMeasureNumbersOnlyAtSystemStart = true;
  display.EngravingRules.SlurPlacementUseSkyBottomLine = true;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    document.head.append(el("script", { src, onload: resolve, onerror: () => reject(new Error(`Couldn't load ${src}`)) }));
  });
}

// Lays the current part out as A4 pages (title, instrument and composer at the top) in a
// hidden box, and gives `use` the page SVGs. Shared by Download PDF and Print.
async function withA4Pages(use) {
  const { piece, part } = current;
  const box = el("div", { className: "pdf-render" });
  document.body.append(box);
  try {
    const pageView = new opensheetmusicdisplay.OpenSheetMusicDisplay(box, {
      autoResize: false, backend: "svg", pageFormat: "A4_P", pageBackgroundColor: "#FFFFFF",
      // The instrument goes in the top-left corner instead (see cornerLabel), not under the title.
      drawTitle: true, drawSubtitle: false, drawComposer: true, drawLyricist: false, drawPartNames: Boolean(part.full),
      drawMetronomeMarks: false,  // their "= 100" text doesn't survive the PDF conversion
    });
    await pageView.load(withDeclaration(await partXml(piece, part)));
    useLibraryDetails(pageView, piece, part);
    pageView.render();
    const pages = [...box.querySelectorAll("svg")];
    pages.forEach(svg => cornerLabel(svg, part.instrument, pageView.EngravingRules));
    await use(pages, piece, part);
  } finally {
    box.remove();
  }
}

// Writes the instrument in bold in the top-left corner of a printed page, lined up with the
// left edge of the music, so players can find their part quickly in a pile of sheets.
function cornerLabel(svg, text, rules) {
  const unit = 10;  // OSMD lays pages out in units of 10 pixels
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("x", rules.PageLeftMargin * unit);
  label.setAttribute("y", Math.max(rules.PageTopMargin * unit - 14, 24));
  label.setAttribute("font-family", "Times New Roman, Times, serif");
  label.setAttribute("font-size", "20");
  label.setAttribute("font-weight", "bold");
  label.setAttribute("fill", "#000000");
  label.textContent = text;
  svg.append(label);
}

// Runs `action` with the button showing `busyText`, and reports a failure.
async function busyButton(id, busyText, action, failure) {
  if (!current) return;
  const button = $(id), label = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try { await action(); }
  catch (err) { alert(`${failure}: ${err.message}`); }
  finally { button.disabled = false; button.textContent = label; }
}

$("download-pdf").addEventListener("click", () => busyButton("download-pdf", "Making PDF…", async () => {
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
  await loadScript("https://cdn.jsdelivr.net/npm/svg2pdf.js@2.2.3/dist/svg2pdf.umd.min.js");
  await withA4Pages(async (pages, piece, part) => {
    const pdf = new window.jspdf.jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    for (const [i, svg] of pages.entries()) {
      if (i > 0) pdf.addPage("a4", "portrait");
      await pdf.svg(svg, { x: 0, y: 0, width: 210, height: 297 });
    }
    pdf.save(`${piece.title} - ${part.instrument}.pdf`);
  });
}, "Sorry, the PDF couldn't be made"));

function printFrame(win) {
  win.focus();
  win.print();
}

// Puts the same A4 pages in a hidden frame and opens the browser's print window for it.
$("print-part").addEventListener("click", () => busyButton("print-part", "Preparing…", async () => {
  await withA4Pages(async (pages, piece, part) => {
    const frame = el("iframe", { title: "Print", ariaHidden: "true" });
    frame.style.cssText = "position: fixed; right: 0; bottom: 0; width: 0; height: 0; border: 0;";
    document.body.append(frame);
    const doc = frame.contentDocument;
    doc.open();
    // Normal print margins, with each page of music scaled to fit inside them. (Making the
    // page exactly A4 with no margins overflows in Safari, which keeps its own margins:
    // the title gets cut off and a blank page follows.)
    doc.write(`<!doctype html><style>
      @page { size: A4 portrait; margin: 12mm; }
      html, body { margin: 0; padding: 0; background: #fff; }
      svg { display: block; width: 100%; height: auto; break-after: page; page-break-after: always; }
      svg:last-child { break-after: auto; page-break-after: auto; }
    </style>`);
    doc.close();
    doc.title = `${piece.title} - ${part.instrument}`;  // also the suggested name if saved as PDF
    for (const svg of pages) {
      const copy = doc.importNode(svg, true);
      // Let the page's own proportions (its viewBox) set the height from the width.
      if (!copy.getAttribute("viewBox")) copy.setAttribute("viewBox", `0 0 ${svg.getAttribute("width")} ${svg.getAttribute("height")}`);
      copy.removeAttribute("width");
      copy.removeAttribute("height");
      doc.body.append(copy);
    }
    await new Promise(r => setTimeout(r, 100));  // let the frame lay out before printing
    printFrame(frame.contentWindow);
    setTimeout(() => frame.remove(), 60000);  // printing is done with it long before this
  });
}, "Sorry, the part couldn't be printed"));

// ---------- Playback ----------


const STEPS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Reads notes from a single-part MusicXML file. Times are in quarter notes.
function parseMusicXML(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  let divisions = 1, tempo = null, t = 0, lastStart = 0, simple = true, time = null, transpose = 0;
  const notes = [];
  // One entry per bar: { label, start, end } plus its repeat signs and 1st/2nd ending, if any.
  const measures = [];
  const openTies = new Map();  // voice:pitch -> the note a tie is still holding on
  let ending = null;  // the numbers of the 1st/2nd... ending we're inside, e.g. [1] or [1, 2]
  for (const measure of doc.querySelectorAll("part > measure")) {
    const measureStart = t;
    let measureEnd = t, forward = false, backward = false, times = 2, endingStops = false;
    for (const node of measure.children) {
      if (node.tagName === "barline") {
        const repeat = node.querySelector("repeat");
        if (repeat?.getAttribute("direction") === "forward") forward = true;
        if (repeat?.getAttribute("direction") === "backward") {
          backward = true;
          times = parseInt(repeat.getAttribute("times"), 10) || 2;
        }
        const e = node.querySelector("ending");
        if (e?.getAttribute("type") === "start") ending = (e.getAttribute("number") ?? "1").split(/[,\s]+/).filter(Boolean).map(Number);
        else if (e) endingStops = true;
        continue;
      }
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
        const note = { start, dur, midi, chord, bar: measures.length };
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
    measures.push({
      label: Number.isFinite(label) ? label : measures.length + 1, start: measureStart, end: measureEnd,
      forward, backward, times, ending,
    });
    if (endingStops) ending = null;
  }
  return { notes, measures, tempo: tempo ?? 100, simple, time: time ?? { beats: 4, beatType: 4 } };
}

// Slider position (0–100) to gain; squared so the slider feels even to the ear.
const sliderGain = (id, max = 1) => (+$(id).value / 100) ** 2 * max;
const OTHERS_MAX = 0.6;  // the rest of the orchestra is several parts at once

// A soft limiter before the speakers, so loud chords with your part at full
// volume don't crackle. Made once per audio context and kept.
let limiter = null;
function limiterFor(ctx) {
  if (limiter?.context !== ctx) {
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(ctx.destination);
  }
  return limiter;
}

// ---------- Sound ----------

// One audio player for the whole visit. Phones only let sound start straight from a tap,
// so it's created (or woken up) inside the Play tap itself, before any music is loaded.
let audioCtx = null;
let silentLoop = null;

function unlockAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  // "playback" asks for a bigger sound buffer: fewer glitches on slower phones and tablets.
  if (!audioCtx) audioCtx = new Ctx({ latencyHint: "playback" });
  if (audioCtx.state !== "running") audioCtx.resume();
  // iPhones mute web audio while the ring/silent switch is on, unless the page says it's
  // playing media. Newer iPhones understand audioSession; older ones need a playing <audio>.
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}
  if (!navigator.audioSession && /iP(hone|ad|od)/.test(navigator.userAgent)) {
    if (!silentLoop) {
      silentLoop = new Audio(silentWav());
      silentLoop.loop = true;
      silentLoop.setAttribute("playsinline", "");
    }
    silentLoop.play().catch(() => {});
  }
}

// A tenth of a second of silence as a WAV file, for the older-iPhone trick above.
function silentWav() {
  const samples = 800, view = new DataView(new ArrayBuffer(44 + samples));
  const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + samples, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  text(36, "data"); view.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) view.setUint8(44 + i, 128);  // 128 = silence in 8-bit audio
  return URL.createObjectURL(new Blob([view.buffer], { type: "audio/wav" }));
}

function playTone(ctx, on, length, midi, volume, destination) {
  const off = on + length;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.value = 440 * 2 ** ((midi - 69) / 12);
  gain.gain.setValueAtTime(0, on);
  gain.gain.linearRampToValueAtTime(volume, on + 0.02);
  gain.gain.setValueAtTime(volume, Math.max(on + 0.02, off - 0.05));
  gain.gain.linearRampToValueAtTime(0, off);
  osc.connect(gain).connect(destination);
  osc.start(on);
  osc.stop(off + 0.01);
}

// A metronome click; higher on the first beat of the bar.
function playClick(ctx, at, accent, destination) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = accent ? 1600 : 1100;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.5, at + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
  osc.connect(gain).connect(destination);
  osc.start(at);
  osc.stop(at + 0.06);
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

// The bars of the chosen section in the order they're played: at a :| it goes back to the
// |: (or the section's start), as many times as marked, and on each pass it takes the right
// 1st/2nd ending. Returns indexes into `measures`.
function playingOrder(measures) {
  const from = +$("from-bar").value, to = +$("to-bar").value;
  let lo = measures.findIndex(m => m.label >= from);
  if (lo < 0) lo = 0;
  let hi = measures.length - 1;
  while (hi > lo && measures[hi].label > to) hi--;

  const order = [], repeatsDone = new Map();
  let i = lo, pass = 1, start = lo, jumpedBack = false, lastWasEnding = false;
  while (i <= hi && order.length < 5000) {
    const m = measures[i];
    // A new repeated passage starts at a |:, or straight after the last ending of the previous one.
    if (!jumpedBack && (m.forward || (lastWasEnding && !m.ending))) { start = i; pass = 1; }
    jumpedBack = false;
    if (m.ending && !m.ending.includes(pass)) { i++; continue; }  // an ending for another time round
    order.push(i);
    lastWasEnding = Boolean(m.ending);
    if (m.backward) {
      const done = repeatsDone.get(i) ?? 1;
      if (done < m.times) {
        repeatsDone.set(i, done + 1);
        pass = done + 1;
        i = start;
        jumpedBack = true;
        continue;
      }
      start = i + 1;
      pass = 1;
    }
    i++;
  }
  return order;
}

// A part's notes laid end to end in playing order, starting at time 0 (in quarter notes).
function notesInOrder(part, order) {
  const byBar = new Map();
  for (const n of part.notes) {
    if (!byBar.has(n.bar)) byBar.set(n.bar, []);
    byBar.get(n.bar).push(n);
  }
  const notes = [];
  let t = 0;
  order.forEach((bar, k) => {
    const m = part.measures[bar];
    if (!m) return;
    const cameFromElsewhere = k === 0 || order[k - 1] !== bar - 1;  // section start or a jump back
    const goesStraightOn = order[k + 1] === bar + 1;
    for (const n of byBar.get(bar) ?? []) {
      notes.push({
        ...n,
        start: t + n.start - m.start,
        written: n.start,  // where it sits in the score, for the moving marker
        // A note held over the bar line is cut at the bar if the music jumps somewhere else.
        dur: goesStraightOn ? n.dur : Math.min(n.dur, m.end - n.start),
        // A tied note at the start of a bar we jumped to has nothing before it holding it on.
        tied: n.tied && !(cameFromElsewhere && Math.abs(n.start - m.start) < 1e-6),
      });
    }
    t += m.end - m.start;
  });
  return { notes, length: t };
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

// Sound is prepared a moment ahead as the music plays (not the whole piece at once, which
// overwhelms phones and tablets), and the marker and count follow the audio clock, allowing
// for the delay before sound reaches the speaker, so they stay in step with what you hear.
const LOOKAHEAD = 0.3;  // seconds of sound prepared ahead
const TICK_MS = 50;     // how often more is prepared

// `repeat` is set when Loop starts the section again: it carries on with the same sound
// groups, so volumes and the metronome setting stay as they are.
async function play({ repeat = false } = {}) {
  if (!current) return;
  const previous = repeat ? playback : null;
  if (previous) endRound(previous);
  else stop();
  const full = Boolean(current.part.full);
  const mine = current.part.file_path;  // undefined for the full score
  // Every part is played, so the volume sliders can bring the others in or out mid-play.
  const paths = current.piece.parts.map(p => p.file_path);
  let texts;
  try {
    texts = await Promise.all(paths.map(loadPart));
  } catch (err) {
    alert(`Couldn't load the music: ${err.message}`);
    return;
  }
  if (repeat && playback !== previous) return;  // stopped while the music was loading
  const parsed = paths.map((path, i) => ({ path, ...parseMusicXML(texts[i]) }));
  const main = parsed.find(p => p.path === mine) ?? parsed[0];  // its bars set the playing order
  const order = playingOrder(main.measures);
  const parts = parsed.map(p => ({ ...p, ...notesInOrder(p, order), isMine: full || p.path === mine }));
  // The marker follows the member's part, or every part for the full score.
  const mainNotes = full
    ? parts.flatMap(p => p.notes).sort((a, b) => a.start - b.start)
    : parts.find(p => p.path === mine).notes;
  const simpleEnough = full ? parts.every(p => p.simple) : main.simple;

  if (!audioCtx) unlockAudio();  // normally already done by the Play tap
  const ctx = audioCtx;
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
    Object.values(groups).forEach(g => g.connect(limiterFor(ctx)));
  }

  // Count-in: bars of clicks (always heard) before the music starts, with the beat
  // number shown on screen, so the player has time to get their instrument up.
  // A pickup (a short first bar, e.g. one beat before bar 1) is part of the count-in's last
  // bar: in 4/4 with a one-beat pickup the count goes 1-2-3-4, 1-2-3 and the pickup is on 4.
  const secPerBeat = 60 / +$("tempo").value;  // per quarter note
  const beatSec = secPerBeat * 4 / main.time.beatType;
  const barQuarters = main.time.beats * 4 / main.time.beatType;
  const first = main.measures[0];
  const firstLength = first ? first.end - first.start : barQuarters;
  const pickup = order[0] === 0 && firstLength < barQuarters - 1e-6 ? firstLength : 0;  // in quarters
  const countBars = +$("countin").value;  // before every round, loops too
  const clickFrom = ctx.currentTime + 0.2;
  const startAt = clickFrom + (countBars ? countBars * barQuarters - pickup : 0) * secPerBeat;
  const firstDownbeat = startAt + pickup * secPerBeat;
  const barLine = firstDownbeat - Math.max(countBars, 1) * barQuarters * secPerBeat;  // the grid every click sits on
  const endAt = startAt + parts.find(p => p.path === main.path).length * secPerBeat;

  // Everything that will sound, in time order: notes, count-in clicks and metronome clicks.
  const events = [];
  for (const part of parts) {
    const destination = part.isMine ? groups.mine : groups.others;
    for (const n of part.notes) {
      if (n.midi === null || n.tied) continue;
      const on = startAt + n.start * secPerBeat;
      events.push({ at: on, sound: () => playTone(ctx, on, n.dur * secPerBeat * 0.95, n.midi, 0.22, destination) });
    }
  }
  const countMarks = [];  // when to show each count-in number
  for (let i = 0, at = barLine; at < endAt - 0.01; i++, at += beatSec) {
    if (at < clickFrom - 0.01) continue;
    const accent = i % main.time.beats === 0, inCount = at < startAt - 0.01;
    events.push({ at, sound: () => playClick(ctx, at, accent, inCount ? groups.countIn : groups.clicks) });
    if (inCount) countMarks.push({ at, beat: (i % main.time.beats) + 1 });
  }
  events.sort((a, b) => a.at - b.at);

  const round = { ctx, groups, scheduler: null, frame: null };
  playback = round;
  $("play").textContent = "■ Stop";

  // Prepare the next moment of sound; at the end of the section, loop or stop.
  let next = 0;
  const tick = () => {
    if (playback !== round) return;
    const now = ctx.currentTime;
    while (next < events.length && events[next].at < now + LOOKAHEAD) {
      const e = events[next++];
      if (e.at >= now - 0.02) e.sound();  // skip anything already too late (e.g. after a stall)
    }
    if (now >= endAt + 0.1) $("loop").checked ? play({ repeat: true }) : stop();
  };
  round.scheduler = setInterval(tick, TICK_MS);
  tick();

  // The marker and count-in numbers, driven by what can actually be heard right now.
  const heardNow = () => ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  let marker = null;
  if (osmd && simpleEnough) {
    // The marker only knows how to step forward through the score as written, so for each
    // note it's moved to that note's written position, jumping back at repeats.
    osmd.cursor.show();
    const steps = cursorSteps();  // written time (quarters) of each marker position
    const stepFor = written => {
      const i = steps.findIndex(t => t >= written - 1e-6);
      return i < 0 ? steps.length - 1 : i;
    };
    let at = 0;
    const moveTo = target => {
      if (target < at) { osmd.cursor.reset(); at = 0; }
      while (at < target) { osmd.cursor.next(); at++; }
    };
    // One marker position per moment a note starts (several parts often start together).
    const onsets = mainNotes
      .filter((n, i, all) => !n.chord && (i === 0 || n.start !== all[i - 1].start))
      .map(n => ({ at: startAt + n.start * secPerBeat, step: stepFor(n.written) }));
    moveTo(onsets[0]?.step ?? 0);
    marker = { onsets, next: 1, moveTo };
  }
  let countNext = 0;
  const draw = () => {
    if (playback !== round) return;
    const now = heardNow();
    while (countNext < countMarks.length && countMarks[countNext].at <= now) {
      $("count-display").textContent = countMarks[countNext++].beat;
    }
    if (now >= startAt - 0.01 && $("count-display").textContent) $("count-display").textContent = "";
    if (marker) {
      let target = null;
      while (marker.next < marker.onsets.length && marker.onsets[marker.next].at <= now) target = marker.onsets[marker.next++].step;
      if (target !== null) marker.moveTo(target);  // only the latest, if several were passed
    }
    round.frame = requestAnimationFrame(draw);
  };
  round.frame = requestAnimationFrame(draw);
}

// Stops preparing sound and moving the marker for a round (the sound groups carry on).
function endRound(round) {
  clearInterval(round.scheduler);
  cancelAnimationFrame(round.frame);
}

// Walks the marker through the score once to learn where each of its positions is.
function cursorSteps() {
  osmd.cursor.reset();
  const it = osmd.cursor.Iterator, steps = [];
  while (!it.EndReached && steps.length < 20000) {
    steps.push(it.currentTimeStamp.RealValue * 4);  // timestamps are in whole notes
    osmd.cursor.next();
  }
  osmd.cursor.reset();
  return steps;
}

function stop() {
  if (!playback) return;
  endRound(playback);
  // Cutting the round's sound groups silences anything already prepared. The audio player
  // itself is kept, so the next Play doesn't need unlocking again.
  Object.values(playback.groups).forEach(g => g.disconnect());
  playback = null;
  silentLoop?.pause();
  $("play").textContent = "▶ Play";
  $("count-display").textContent = "";
  if (osmd?.cursor) osmd.cursor.hide();
}

// Wake the audio straight from the tap (phones insist), then load and play.
$("play").addEventListener("click", () => {
  if (playback) { stop(); return; }
  unlockAudio();
  play();
});
$("tempo").addEventListener("input", e => { $("tempo-val").textContent = e.target.value; });

// Volume and metronome changes apply straight away, even while playing.
function setGroup(name, value) {
  if (playback) playback.groups[name].gain.setTargetAtTime(value, playback.ctx.currentTime, 0.03);
}
$("vol-mine").addEventListener("input", () => setGroup("mine", sliderGain("vol-mine")));
$("vol-others").addEventListener("input", () => setGroup("others", sliderGain("vol-others", OTHERS_MAX)));
$("metronome").addEventListener("change", e => setGroup("clicks", e.target.checked ? 1 : 0));

start();
