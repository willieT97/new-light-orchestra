// Librarian tools: add pieces and upload parts, manage members, read join requests
// and the mailing list. The database rules only allow admins to do any of this.

const $ = id => document.getElementById(id);
const fmtDate = s => new Date(s).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function showMessage(title, text) {
  $("message-title").textContent = title;
  $("message-text").textContent = text;
  $("message-view").hidden = false;
  $("admin-view").hidden = true;
}

function status(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
  $("status").hidden = !text;
  if (text && !isError) setTimeout(() => { if ($("status").textContent === text) $("status").hidden = true; }, 4000);
}

// Runs a Supabase call and reports its error, if any. Returns the data or null.
async function run(promise, okMessage) {
  const { data, error } = await promise;
  if (error) { status(error.message, true); return null; }
  if (okMessage) status(okMessage);
  return data ?? true;
}

async function start() {
  if (!sb) { showMessage("Not connected yet", "Add your Supabase project details to config.js (see SETUP.md)."); return; }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { showMessage("Please sign in", "Sign in on the members' page first, then come back here."); return; }
  const { data: me } = await sb.from("members").select("is_admin").eq("email", session.user.email.toLowerCase()).maybeSingle();
  if (!me?.is_admin) { showMessage("Librarians only", "Your account doesn't have librarian access."); return; }

  $("admin-view").hidden = false;
  $("instrument-list").append(...INSTRUMENTS.map(i => el("option", { value: i })));
  await Promise.all([loadPieces(), loadMembers(), loadRequests(), loadMailing()]);
}

// ---------- Music ----------

async function loadPieces() {
  const pieces = await run(sb.from("pieces")
    .select("id, title, composer, concert, parts(id, instrument, file_path)")
    .order("created_at"));
  if (!pieces) return;
  const box = $("admin-pieces");
  box.replaceChildren();
  if (!pieces.length) box.append(el("p", { className: "muted", textContent: "No pieces yet. Add one to get started." }));

  for (const piece of pieces) {
    const parts = el("ul", { className: "schedule" });
    for (const part of [...piece.parts].sort((a, b) => a.instrument.localeCompare(b.instrument))) {
      const del = el("button", { className: "link-btn", type: "button", textContent: "Remove" });
      del.addEventListener("click", () => deletePart(part));
      parts.append(el("li", {}, el("span", { textContent: part.instrument }), del));
    }

    const form = el("form", { className: "inline-form" },
      el("input", { name: "instrument", placeholder: "Instrument", required: true, autocomplete: "off" }),
      el("input", { name: "file", type: "file", accept: ".musicxml,.xml", required: true }),
      el("button", { className: "btn small", type: "submit", textContent: "Upload part" }));
    form.instrument.setAttribute("list", "instrument-list");
    form.addEventListener("submit", e => { e.preventDefault(); uploadPart(piece, form); });

    const delPiece = el("button", { className: "link-btn", type: "button", textContent: "Delete piece" });
    delPiece.addEventListener("click", () => deletePiece(piece));

    box.append(el("div", { className: "card piece-admin" },
      el("div", { className: "viewer-head" },
        el("div", {},
          el("h3", { textContent: piece.title }),
          el("span", { className: "muted", textContent: [piece.composer, piece.concert].filter(Boolean).join(" · ") })),
        delPiece),
      piece.parts.length ? parts : el("p", { className: "muted", textContent: "No parts uploaded yet." }),
      form));
  }
}

$("piece-form").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target;
  const ok = await run(sb.from("pieces").insert({
    title: f.title.value.trim(), composer: f.composer.value.trim(), concert: f.concert.value.trim(),
  }), `Added "${f.title.value.trim()}".`);
  if (ok) { f.reset(); loadPieces(); }
});

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "part";

async function uploadPart(piece, form) {
  const file = form.file.files[0];
  const instrument = form.instrument.value.trim();
  const text = await file.text();
  if (!/<score-(partwise|timewise)/.test(text)) {
    status(`"${file.name}" doesn't look like an uncompressed MusicXML file.`, true);
    return;
  }
  const path = `${piece.id}/${slug(instrument)}-${Date.now()}.musicxml`;
  form.querySelector("button").disabled = true;
  const uploaded = await run(sb.storage.from("music").upload(path, file, { contentType: "application/xml", cacheControl: "0" }));
  if (uploaded) {
    const ok = await run(sb.from("parts").insert({ piece_id: piece.id, instrument, file_path: path }),
      `Uploaded ${instrument} for "${piece.title}".`);
    if (!ok) await sb.storage.from("music").remove([path]);  // don't leave an orphaned file
  }
  form.querySelector("button").disabled = false;
  loadPieces();
}

async function deletePart(part) {
  if (!confirm(`Remove the ${part.instrument} part?`)) return;
  if (!await run(sb.storage.from("music").remove([part.file_path]))) return;
  await run(sb.from("parts").delete().eq("id", part.id), `Removed ${part.instrument}.`);
  loadPieces();
}

async function deletePiece(piece) {
  if (!confirm(`Delete "${piece.title}" and all ${piece.parts.length} of its parts?`)) return;
  if (piece.parts.length && !await run(sb.storage.from("music").remove(piece.parts.map(p => p.file_path)))) return;
  await run(sb.from("pieces").delete().eq("id", piece.id), `Deleted "${piece.title}".`);
  loadPieces();
}

// ---------- Full score ----------

// Score names → the standard names members use. Order matters ("Bass Clarinet" before "Clarinet").
const INSTRUMENT_PATTERNS = [
  [/^(violins?|vlns?|vn|vl)\.?\s*(1|i)$/i, "Violin I"],
  [/^(violins?|vlns?|vn|vl)\.?\s*(2|ii)$/i, "Violin II"],
  [/^(violas?|vla|va)\b/i, "Viola"],
  [/^(violon)?cellos?\b|^(vc|vlc)\b/i, "Cello"],
  [/^(contrabass|double ?bass(es)?|kontrabass|basses|cb|db)\b|^bass$/i, "Double Bass"],
  [/^(piccolo|picc)\b/i, "Piccolo"],
  [/^(flutes?|fl)\b/i, "Flute"],
  [/^(cor anglais|english horn)\b/i, "Cor Anglais"],
  [/^(oboes?|ob)\b/i, "Oboe"],
  [/^bass clarinet\b/i, "Bass Clarinet"],
  [/^(clarinets?|cl)\b/i, "Clarinet"],
  [/^contra(bassoon|fagotto)\b/i, "Contrabassoon"],
  [/^(bassoons?|bsn|fg|fagotto?)\b/i, "Bassoon"],
  [/^(french horns?|horns?|hn|cor)\b/i, "Horn"],
  [/^(trumpets?|tpt|tp)\b/i, "Trumpet"],
  [/^bass trombone\b/i, "Bass Trombone"],
  [/^(trombones?|tbn|trb)\b/i, "Trombone"],
  [/^tuba\b/i, "Tuba"],
  [/^(timpani|timp)\b/i, "Timpani"],
  [/^(percussion|perc|drums?|snare|cymbals?|glockenspiel|xylophone|triangle)\b/i, "Percussion"],
  [/^harp\b/i, "Harp"],
  [/^(piano|pno)\b/i, "Piano"],
];
const ROMAN = { I: 1, II: 2, III: 3, IV: 4 };

function standardInstrument(raw) {
  const name = raw.replace(/\s+in\s+[A-G](b|♭|#|♯)?(?=\s|\.|$)/i, "").replace(/\s+/g, " ").trim();
  for (const [pattern, standard] of INSTRUMENT_PATTERNS) {
    if (!pattern.test(name)) continue;
    if (standard.startsWith("Violin ")) return standard;
    // Keep a desk number: "Flute 2", "Horn III" → "Horn 3".
    const num = name.match(/\s(\d|I{1,3}|IV)\.?$/i)?.[1];
    const n = num && (/\d/.test(num) ? num : ROMAN[num.toUpperCase()]);
    return n ? `${standard} ${n}` : standard;
  }
  return name;
}

// Splits a full score into one single-part MusicXML file per instrument.
function splitScore(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const root = doc.documentElement;
  if (doc.querySelector("parsererror") || root.tagName !== "score-partwise") {
    throw new Error("This doesn't look like an uncompressed MusicXML score (.musicxml or .xml).");
  }
  const meta = {
    title: (root.querySelector(":scope > work > work-title") ?? root.querySelector(":scope > movement-title"))?.textContent.trim() ?? "",
    composer: root.querySelector(':scope > identification > creator[type="composer"]')?.textContent.trim() ?? "",
  };
  const parts = [...root.querySelectorAll(":scope > part")].map(part => {
    const id = part.getAttribute("id");
    const single = doc.cloneNode(true);
    const singleRoot = single.documentElement;
    singleRoot.querySelectorAll(":scope > part").forEach(p => { if (p.getAttribute("id") !== id) p.remove(); });
    const list = singleRoot.querySelector(":scope > part-list");
    [...list.children].forEach(c => { if (!(c.tagName === "score-part" && c.getAttribute("id") === id)) c.remove(); });
    const scorePart = list.querySelector("score-part");
    const name = (scorePart.querySelector("part-name")?.textContent
      || scorePart.querySelector("instrument-name")?.textContent || id).trim();
    // XMLSerializer drops the <?xml?> declaration, which the score display needs.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(single)}`;
    return { name, instrument: standardInstrument(name), xml };
  });
  if (!parts.length) throw new Error("No parts were found in this score.");
  return { meta, parts };
}

let scoreParts = [];

$("score-form").file.addEventListener("change", async e => {
  const f = $("score-form");
  const file = e.target.files[0];
  $("score-details").hidden = true;
  if (!file) return;
  let split;
  try { split = splitScore(await file.text()); }
  catch (err) { status(err.message, true); return; }

  scoreParts = split.parts;
  // Skip MuseScore's placeholder text for scores where the title wasn't filled in.
  f.title.value = /^untitled score$/i.test(split.meta.title) ? "" : split.meta.title;
  f.composer.value = /^composer( \/ arranger)?$/i.test(split.meta.composer) ? "" : split.meta.composer;
  const rows = scoreParts.map((part, i) => {
    const include = el("input", { type: "checkbox", checked: true, ariaLabel: `Include ${part.name}` });
    include.addEventListener("change", () => { part.skip = !include.checked; });
    const name = el("input", { value: part.instrument, required: true, ariaLabel: `Instrument name for ${part.name}` });
    name.setAttribute("list", "instrument-list");
    name.addEventListener("input", () => { part.instrument = name.value.trim(); });
    return el("tr", {}, el("td", {}, include), el("td", { className: "muted", textContent: part.name }), el("td", {}, name));
  });
  $("score-parts").replaceChildren(
    el("thead", {}, el("tr", {}, ...["Use", "In the score", "Instrument name"].map(h => el("th", { textContent: h })))),
    el("tbody", {}, ...rows));
  $("score-details").hidden = false;
  status(`Found ${scoreParts.length} parts. Check the instrument names, then upload.`);
});

$("score-form").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, button = f.querySelector("button[type=submit]");
  const chosen = scoreParts.filter(p => !p.skip);
  if (!chosen.length) { status("Choose at least one part to upload.", true); return; }
  if (chosen.some(p => !p.instrument)) { status("Every part needs an instrument name.", true); return; }

  button.disabled = true;
  const piece = await run(sb.from("pieces").insert({
    title: f.title.value.trim(), composer: f.composer.value.trim(), concert: f.concert.value.trim(),
  }).select().single());
  if (!piece) { button.disabled = false; return; }

  const uploaded = [];
  for (const [i, part] of chosen.entries()) {
    status(`Uploading ${i + 1} of ${chosen.length}: ${part.instrument}…`);
    const path = `${piece.id}/${slug(part.instrument)}-${Date.now()}-${i}.musicxml`;
    const blob = new Blob([part.xml], { type: "application/xml" });
    if (!await run(sb.storage.from("music").upload(path, blob, { contentType: "application/xml", cacheControl: "0" }))) break;
    uploaded.push({ piece_id: piece.id, instrument: part.instrument, file_path: path });
  }

  if (uploaded.length === chosen.length && await run(sb.from("parts").insert(uploaded))) {
    status(`Added "${piece.title}" with ${uploaded.length} parts.`);
    f.reset();
    $("score-details").hidden = true;
    scoreParts = [];
  } else {
    // Something failed part-way: undo, so there's no half-uploaded piece.
    if (uploaded.length) await sb.storage.from("music").remove(uploaded.map(u => u.file_path));
    await sb.from("pieces").delete().eq("id", piece.id);
    if ($("status").hidden || !$("status").classList.contains("error")) status("Upload failed, nothing was saved. Please try again.", true);
  }
  button.disabled = false;
  loadPieces();
});

// ---------- Members ----------

// One box per instrument, with "Add another instrument" for members who play more than one.
function instrumentPicker(values) {
  const box = el("div", { className: "instrument-picker" });
  const addButton = el("button", { type: "button", className: "link-btn", textContent: "+ Add another instrument" });
  const tidy = () => {
    const rows = [...box.querySelectorAll(".instrument-row")];
    rows.forEach((row, i) => {
      row.querySelector("input").required = i === 0;
      row.querySelector("button").hidden = rows.length < 2;
    });
  };
  const addRow = (value = "") => {
    const input = el("input", { value, autocomplete: "off", ariaLabel: "Instrument" });
    input.setAttribute("list", "instrument-list");
    const remove = el("button", { type: "button", className: "link-btn", textContent: "Remove", ariaLabel: "Remove this instrument" });
    const row = el("div", { className: "instrument-row" }, input, remove);
    remove.addEventListener("click", () => { row.remove(); tidy(); });
    box.insertBefore(row, addButton);
    tidy();
    return input;
  };
  addButton.addEventListener("click", () => addRow().focus());
  box.append(addButton);
  const start = splitInstruments(values);
  (start.length ? start : [""]).forEach(v => addRow(v));
  return { node: box, value: () => joinInstruments([...box.querySelectorAll("input")].map(i => i.value)) };
}

let newMemberInstruments;
function resetMemberInstruments() {
  newMemberInstruments = instrumentPicker("");
  $("member-instruments").replaceChildren(newMemberInstruments.node);
}
resetMemberInstruments();

// The instrument cell of the members list, with "Change" to edit it in place.
function instrumentCell(m) {
  const cell = el("td");
  const show = () => {
    const change = el("button", { className: "link-btn", type: "button", textContent: "Change" });
    change.addEventListener("click", edit);
    cell.replaceChildren(el("div", { textContent: splitInstruments(m.instrument).join(", ") }), change);
  };
  const edit = () => {
    const picker = instrumentPicker(m.instrument);
    const save = el("button", { className: "btn small", type: "button", textContent: "Save" });
    const cancel = el("button", { className: "link-btn", type: "button", textContent: "Cancel" });
    cancel.addEventListener("click", show);
    save.addEventListener("click", async () => {
      const instrument = picker.value();
      if (!instrument) { status("A member needs at least one instrument.", true); return; }
      save.disabled = true;
      if (await run(sb.from("members").update({ instrument }).eq("email", m.email), `Saved ${m.name}'s instruments.`)) {
        m.instrument = instrument;
        show();
      } else save.disabled = false;
    });
    cell.replaceChildren(picker.node, el("div", { className: "instrument-actions" }, save, cancel));
    picker.node.querySelector("input").focus();
  };
  show();
  return cell;
}

// Whether a member has set up their account, from member_account_statuses() in Supabase.
// If that hasn't been added to the database yet, the column just shows a dash.
function accountCell(account) {
  if (!account) return el("td", { className: "muted", textContent: "–" });
  if (account.status === "none") return el("td", { className: "muted", textContent: "Not yet" });
  if (account.status === "unconfirmed") {
    return el("td", {}, el("span", { className: "tag need account-tag", textContent: "Email not confirmed" }));
  }
  const signedIn = account.last_sign_in && new Date(account.last_sign_in);
  const last = signedIn && signedIn.toLocaleDateString("en-IE", {
    day: "numeric", month: "short", year: signedIn.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
  return el("td", {}, el("span", { className: "tag", textContent: "Set up" }),
    last ? el("div", { className: "muted account-last", textContent: `Last signed in ${last}` }) : null);
}

async function loadMembers() {
  const [members, accounts] = await Promise.all([
    run(sb.from("members").select("*").order("name")),
    sb.rpc("member_account_statuses").then(({ data }) => data ?? []),
  ]);
  if (!members) return;
  const accountOf = new Map(accounts.map(a => [a.email, a]));
  const rows = members.map(m => {
    const del = el("button", { className: "link-btn", type: "button", textContent: "Remove" });
    del.addEventListener("click", async () => {
      if (!confirm(`Remove ${m.name}? They will lose access to the music straight away.`)) return;
      if (await run(sb.from("members").delete().eq("email", m.email), `Removed ${m.name}.`)) loadMembers();
    });
    return el("tr", {},
      el("td", { textContent: m.name }),
      instrumentCell(m),
      el("td", { textContent: m.email }),
      accountCell(accountOf.get(m.email)),
      el("td", {}, m.is_admin ? el("span", { className: "tag need", textContent: "Admin" }) : ""),
      el("td", {}, del));
  });
  $("members-table").replaceChildren(
    el("thead", {}, el("tr", {}, ...["Name", "Instrument", "Email", "Account", "", ""].map(h => el("th", { textContent: h })))),
    el("tbody", {}, ...rows));
}

$("member-form").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target;
  const ok = await run(sb.from("members").insert({
    email: f.email.value.trim().toLowerCase(), name: f.name.value.trim(),
    instrument: newMemberInstruments.value(), is_admin: f.is_admin.checked,
  }), `Added ${f.name.value.trim()}. We've emailed ${f.email.value.trim()} a link to set up their account.`);
  if (ok) { f.reset(); resetMemberInstruments(); loadMembers(); }
});

// ---------- Join requests ----------

async function loadRequests() {
  const requests = await run(sb.from("join_requests").select("*").order("created_at", { ascending: false }));
  if (!requests) return;
  if (!requests.length) {
    $("requests-table").replaceChildren(el("tbody", {}, el("tr", {}, el("td", { className: "muted", textContent: "No join requests yet." }))));
    return;
  }
  const rows = requests.map(r => {
    const add = el("button", { className: "link-btn", type: "button", textContent: "Add as member" });
    add.addEventListener("click", () => {
      const f = $("member-form");
      f.email.value = r.email; f.name.value = r.name; f.instrument.value = r.instrument;
      f.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    const del = el("button", { className: "link-btn", type: "button", textContent: "Delete" });
    del.addEventListener("click", async () => {
      if (confirm(`Delete the request from ${r.name}?`) && await run(sb.from("join_requests").delete().eq("id", r.id))) loadRequests();
    });
    return el("tr", {},
      el("td", { textContent: fmtDate(r.created_at) }),
      el("td", {}, el("strong", { textContent: r.name }), el("br"), el("a", { href: `mailto:${r.email}`, textContent: r.email })),
      el("td", { textContent: r.instrument }),
      el("td", { textContent: r.level ?? "" }),
      el("td", { textContent: r.message ?? "" }),
      el("td", {}, add, el("br"), del));
  });
  $("requests-table").replaceChildren(
    el("thead", {}, el("tr", {}, ...["Date", "Name", "Instrument", "Experience", "Message", ""].map(h => el("th", { textContent: h })))),
    el("tbody", {}, ...rows));
}

// ---------- Mailing list ----------

async function loadMailing() {
  const rows = await run(sb.from("mailing_list").select("email").order("created_at"));
  if (!rows) return;
  $("mailing-count").textContent = `${rows.length} subscriber${rows.length === 1 ? "" : "s"}`;
  $("mailing-emails").value = rows.map(r => r.email).join(", ");
}

$("copy-emails").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("mailing-emails").value); status("Emails copied."); }
  catch { $("mailing-emails").select(); }
});

start();
