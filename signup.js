// Members sign up: a few steps that check the librarian has added this email,
// then let the person choose a password (with one confirmation email).

const $ = id => document.getElementById(id);
const STEPS = ["step-registered", "step-email", "step-not-listed", "step-has-account", "step-password", "step-done"];
// Checking in happens under a night sky; creating the account brings the sunrise.
const NIGHT_STEPS = ["step-email", "step-not-listed", "step-has-account", "step-password"];
let email = "";

function showStep(step) {
  for (const s of STEPS) $(s).hidden = s !== step;
  document.body.classList.toggle("night", NIGHT_STEPS.includes(step));
  document.body.classList.toggle("day", step === "step-done");
  document.querySelectorAll(".signup-email").forEach(e => { e.textContent = email; });
  $("email-error").textContent = "";
  $("password-error").textContent = "";
  $(step).querySelector("input")?.focus();
}

document.addEventListener("click", e => {
  const target = e.target.closest("[data-step]");
  if (target) showStep(target.dataset.step);
});

if (!sb) {
  $("not-connected").hidden = false;
  document.querySelectorAll("form button").forEach(b => { b.disabled = true; });
}

// Disables the form's button while `action` runs, and shows any error in `errorBox`.
async function submitStep(form, errorBox, action) {
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try { await action(); }
  catch (err) { $(errorBox).textContent = friendlyError(err); }
  finally { button.disabled = false; }
}

$("email-form").addEventListener("submit", e => {
  e.preventDefault();
  submitStep(e.target, "email-error", async () => {
    email = e.target.email.value.trim().toLowerCase();
    const { data, error } = await sb.rpc("member_signup_status", { check_email: email });
    if (error) throw new Error("Sorry, we couldn't check that right now. Please try again.");
    showStep({ not_listed: "step-not-listed", has_account: "step-has-account", ready: "step-password" }[data] ?? "step-not-listed");
  });
});

$("password-form").addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target;
  submitStep(f, "password-error", async () => {
    if (f.password.value !== f.confirm.value) throw new Error("The two passwords don't match.");
    const { error } = await sb.auth.signUp({
      email,
      password: f.password.value,
      options: { emailRedirectTo: new URL("members.html", location.href).href },
    });
    if (error && /already registered/i.test(error.message)) { showStep("step-has-account"); return; }
    if (error) throw error;
    f.reset();
    showStep("step-done");
  });
});
