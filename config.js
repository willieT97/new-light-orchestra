// Connection to your Supabase project. Find both values in the Supabase dashboard:
// Project Settings → API (the "Project URL" and the "anon" / "publishable" key).
// These are safe to publish: the security rules in supabase/schema.sql protect the data.
const SUPABASE_URL = "https://fxkvtokdkxpvqrksoyox.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_kIuNBFzTwHsahDYk4hhZnA_i9Q3ttBx";

const sb = window.supabase && !SUPABASE_URL.includes("YOUR-PROJECT")
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      // Never keep private data (e.g. music files) in the browser cache, where the
      // next person using a shared computer could get it without signing in.
      global: { fetch: (url, options) => fetch(url, { ...options, cache: "no-store" }) },
    })
  : null;

// Standard instrument names. Members and parts must use the same name to match up.
const INSTRUMENTS = [
  "Piccolo", "Flute", "Oboe", "Cor Anglais", "Clarinet", "Bass Clarinet", "Bassoon", "Contrabassoon",
  "Horn", "Trumpet", "Trombone", "Bass Trombone", "Tuba", "Timpani", "Percussion", "Harp", "Piano",
  "Violin I", "Violin II", "Viola", "Cello", "Double Bass",
];

// A member can play more than one instrument. They're kept together as "Violin I, Viola".
const splitInstruments = s => [...new Set(String(s ?? "").split(",").map(x => x.trim()).filter(Boolean))];
const joinInstruments = list => splitInstruments(list.join(",")).join(", ");
// "Violin I", "Violin I or Viola", "Flute, Piccolo or Oboe"
const instrumentsInWords = s => splitInstruments(s).join(", ").replace(/, ([^,]*)$/, " or $1");

// Turns a Supabase sign-in/sign-up error into something a member can act on. When Supabase
// can't send an email (e.g. the email settings are wrong) it returns an error with no message.
function friendlyError(err) {
  const message = String(err?.message ?? "").trim();
  if (/rate limit/i.test(message)) return "Too many emails have been sent in the last hour. Please try again a bit later.";
  if (!message || message === "{}" || /sending.*email|smtp/i.test(message) || err?.status >= 500) {
    return "Sorry, we couldn't send the email just now. Please try again later, or contact williamtroymusic@gmail.com.";
  }
  return message;
}

// Small helper for building elements safely (text is never treated as HTML).
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c != null && c !== false));
  return node;
}

// ---------- Rehearsals ----------
// Every Tuesday, 6:30–7:45pm. The home page and members area list the next few
// themselves, so the dates never go out of date.
const REHEARSAL = { weekday: 2, start: "6:30", end: "7:45pm", endHour: 19, endMinute: 45 };  // 2 = Tuesday

// The next `count` rehearsal dates. Today counts until the rehearsal has finished.
function nextRehearsals(count, now = new Date()) {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const finished = now.getHours() * 60 + now.getMinutes() >= REHEARSAL.endHour * 60 + REHEARSAL.endMinute;
  let ahead = (REHEARSAL.weekday - day.getDay() + 7) % 7;
  if (ahead === 0 && finished) ahead = 7;
  day.setDate(day.getDate() + ahead);
  return Array.from({ length: count }, (_, i) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + 7 * i));
}

// "Tue 17 Nov"
const rehearsalDate = d => d.toLocaleDateString("en-IE", { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
