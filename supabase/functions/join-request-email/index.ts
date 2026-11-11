// Supabase Edge Function that sends the orchestra's automatic emails. Database Webhooks
// (event: Insert) call it with the new row:
//  - join_requests: someone filled in "Register your interest". It emails them a thank-you,
//    and emails the orchestra a copy of their details.
//  - members: the librarian added a member. It emails them a link to set up their account.
//
// Needs one secret (Edge Functions → Secrets): RESEND_API_KEY.
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

const FROM = "New Light Orchestra <noreply@newlightorchestra.ie>";
const ORCHESTRA_EMAIL = "williamtroymusic@gmail.com";  // gets a copy of every sign-up; replies go here too
const MAX_PER_DAY = 50;  // the form is public, so cap how many emails it can trigger
const SIGNUP_PAGE = "https://newlightorchestra.ie/signup.html";

const escape = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// How many join requests match `filter` in the last 24 hours (read with the service key).
async function recentCount(filter: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/join_requests?select=id&created_at=gte.${since}${filter}`, {
    headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "count=exact", Range: "0-0" },
  });
  return Number(res.headers.get("content-range")?.split("/")[1] ?? 0);
}

async function sendEmail(email: Record<string, unknown>) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, ...email }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

// The sign-up as saved in the database (the caller's copy is never trusted).
async function savedRequest(id: unknown) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/join_requests?select=*&id=eq.${encodeURIComponent(String(id))}`, {
    headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const rows = res.ok ? await res.json() : [];
  return rows[0] ?? null;
}

// ---------- New member ----------

// The member as saved in the database (the caller's copy is never trusted).
async function savedMember(email: unknown) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/members?select=*&email=eq.${encodeURIComponent(String(email ?? ""))}`, {
    headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const rows = res.ok ? await res.json() : [];
  return rows[0] ?? null;
}

// "ready", "has_account" or "not_listed": the same check the sign-up page uses.
async function signupStatus(email: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/member_signup_status`, {
    method: "POST",
    headers: { apikey: ANON_KEY!, Authorization: `Bearer ${ANON_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ check_email: email }),
  });
  return res.ok ? await res.json() : "ready";
}

// Welcomes a newly added member and sends them to the sign-up page. Skips anyone who
// already has an account (e.g. removed and added again), since they just sign in.
async function memberAdded(email: unknown) {
  const m = await savedMember(email);
  if (!m?.email) return new Response("ignored", { status: 200 });
  if (await signupStatus(m.email) === "has_account") return new Response("already has an account", { status: 200 });

  const firstName = escape(String(m.name).trim().split(/\s+/)[0]);
  try {
    await sendEmail({
      to: m.email,
      reply_to: ORCHESTRA_EMAIL,
      subject: "Welcome to New Light Orchestra: set up your members account",
      html: `<p>Hi ${firstName},</p>
<p>Welcome to New Light Orchestra! You've been added as a member (${escape(m.instrument)}), so you can now set up your account for the members area, where you'll find your music and can play along with it.</p>
<p><a href="${SIGNUP_PAGE}" style="display:inline-block;background:#e3c271;color:#1b2440;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:600">Set up my account</a></p>
<p>Use this email address (${escape(m.email)}) when it asks, then choose a password.</p>
<p>Rehearsals are every Tuesday, 6:30–7:45pm, in the Methodist Church Hall, Portlaoise.</p>
<p>If you have any questions, just reply to this email.</p>
<p>Best wishes,<br>William Troy<br>Musical Director, New Light Orchestra</p>`,
    });
  } catch (err) {
    console.error(String(err));
    return new Response(String(err), { status: 500 });
  }
  return new Response("sent", { status: 200 });
}

// The role inside the caller's key: "service_role" for the database webhook, "anon" for
// the website's public key. Keep "Verify JWT" ON in this function's settings: Supabase then
// checks every key is genuine before this runs, so a made-up "service_role" can't get in.
function callerRole(req: Request): string | null {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "="))).role ?? null;
  } catch {
    return null;
  }
}

Deno.serve(async req => {
  // Only the database webhook may call this (it sends the service key); the website's
  // public key also passes "Verify JWT", so check the role as well.
  if (callerRole(req) !== "service_role") {
    return new Response("Forbidden", { status: 403 });
  }
  const payload = await req.json().catch(() => null);
  if (payload?.type !== "INSERT") return new Response("ignored", { status: 200 });
  if (payload?.table === "members") return memberAdded(payload.record?.email);
  if (payload?.table !== "join_requests" || !payload?.record?.id) return new Response("ignored", { status: 200 });
  const r = await savedRequest(payload.record.id);
  if (!r?.email) return new Response("ignored", { status: 200 });

  // Someone could type other people's addresses into the public form. Only send one
  // thank-you per address per day, and stop altogether past a daily cap.
  const sameEmail = await recentCount(`&email=eq.${encodeURIComponent(r.email)}`);
  const today = await recentCount("");
  const sendThanks = sameEmail <= 1 && today <= MAX_PER_DAY;

  const firstName = escape(String(r.name).trim().split(/\s+/)[0]);
  const details = [
    ["Name", r.name], ["Email", r.email], ["Instrument", r.instrument],
    ["Experience", r.level], ["Message", r.message],
  ].filter(([, v]) => v).map(([k, v]) => `<p><strong>${k}:</strong> ${escape(v)}</p>`).join("");

  const results = await Promise.allSettled([
    sendThanks && sendEmail({
      to: r.email,
      reply_to: ORCHESTRA_EMAIL,
      subject: "Thanks for your interest in New Light Orchestra",
      html: `<p>Hi ${firstName},</p>
<p>Thanks for registering your interest in New Light Orchestra! We've received your details and will be back to you soon.</p>
<p>If you have any questions in the meantime, just reply to this email.</p>
<p>Best wishes,<br>William Troy<br>Musical Director, New Light Orchestra</p>`,
    }),
    today <= MAX_PER_DAY && sendEmail({
      to: ORCHESTRA_EMAIL,
      reply_to: r.email,
      subject: `New join request: ${String(r.name).slice(0, 80)} (${String(r.instrument).slice(0, 40)})`,
      html: `<p>Someone has registered their interest on the website.</p>${details}
<p>Reply to this email to answer them directly, or add them as a member in Librarian tools.</p>`,
    }),
  ]);

  const failed = results.filter(x => x.status === "rejected").map(x => String((x as PromiseRejectedResult).reason));
  if (failed.length) {
    console.error(failed.join("\n"));
    return new Response(failed.join("\n"), { status: 500 });
  }
  return new Response("sent", { status: 200 });
});
