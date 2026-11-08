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
