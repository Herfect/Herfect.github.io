// The verification code, fixed until the Supabase email template and SMTP sender are set up (owner decision
// 2026-11-19): no email is sent; the page checks this code and makes the account with POST /auth/v1/signup.
// Set it to "" to restore the emailed code (and revert backend migration 20261119000000_early_access_fixed_code.sql).
const FIXED_CODE = "123456";

// Early-access sign-up on the app's Supabase project, so the account also signs in to the app. Flow and errors:
// docs/knowledge/development/backend/early-access.md. The URL and publishable key are the app's HERFECT_SUPABASE_URL
// and HERFECT_SUPABASE_KEY (project.yml); the key is public by design and row level security guards the data.
const SUPABASE_URL = "https://yeoqkjfwwfgfshaqetrg.supabase.co";
const SUPABASE_KEY = "sb_publishable_2HmY19jG2l29DA11_XyBGQ_fU3L12QJ";
const MIN_PASSWORD = 6; // the app's LocalLogin.minimumPasswordLength
const RESEND_SECONDS = 60; // Supabase Auth sends at most one email per address a minute
// User metadata set only when the code request creates the account: its password is still to be chosen here.
// An account the app made earlier never carries it, so its password is never replaced.
const PENDING_KEY = "early_access_password";

const state = { email: "", password: "", token: "", cooldownUntil: 0, timer: 0 };

const steps = [...document.querySelectorAll("[data-step]")];
const marks = [...document.querySelectorAll("[data-step-mark]")];
const accountForm = document.getElementById("step-account");
const codeForm = document.getElementById("step-code");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const confirmInput = document.getElementById("confirm");
const codeInput = document.getElementById("code");
const resendButton = codeForm.querySelector("[data-resend]");
const resendStatus = codeForm.querySelector("[data-resend-status]");

// With the fixed code no email goes out: the code step asks for the code without promising one and has no resend.
if (FIXED_CODE) {
  codeForm.querySelector(".signup-intro").textContent = "Enter your 6-digit code.";
  codeForm.querySelector('label[for="code"]').textContent = "Your code";
  document.querySelector('[data-step-mark="code"]').lastChild.textContent = "Code";
  accountForm.querySelector('button[type="submit"]').firstChild.textContent = "Continue";
  resendButton.hidden = true;
}

const MESSAGES = {
  offline: "We can't reach Herfect right now. Check your connection and try again.",
  email_address_invalid: "That email address can't receive mail. Check it and try again.",
  email_address_not_authorized: "Our emails can't reach this address yet. Please try again later.",
  over_email_send_rate_limit: "We've sent a lot of codes just now. Wait a few minutes, then try again.",
  over_request_rate_limit: "We've sent a lot of codes just now. Wait a few minutes, then try again.",
  validation_failed: "Check the email address and try again.",
  signup_disabled: "Sign-up is closed for the moment. Please try again later.",
  otp_disabled: "Sign-up is closed for the moment. Please try again later.",
  email_provider_disabled: "Sign-up is closed for the moment. Please try again later.",
  otp_expired: "That code doesn't match or has expired. Use the newest email, or send a new code.",
  weak_password: "That password is too easy to guess. Try a longer one with letters and numbers.",
  session_expired: "That took a little long. Enter your details again and we'll send a new code.",
  user_already_exists: "You already have a Herfect account. Sign in to the app with your email and password.",
  email_exists: "You already have a Herfect account. Sign in to the app with your email and password.",
};

class ApiError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function api(path, { method = "POST", body, token } = {}) {
  const headers = { apikey: SUPABASE_KEY, "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(SUPABASE_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError("offline", 0);
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    // Supabase Auth names the error in `error_code`; PostgREST and raised SQL errors put it in `message`.
    const code = data?.error_code || data?.message || `http_${response.status}`;
    throw new ApiError(code, response.status);
  }
  return data;
}

function messageFor(error) {
  if (error.status === 401 && !MESSAGES[error.code]) return MESSAGES.session_expired;
  return MESSAGES[error.code] || `Something went wrong (${error.code}). Please try again.`;
}

function show(name) {
  steps.forEach((step) => {
    step.hidden = step.dataset.step !== name;
  });
  const index = marks.findIndex((mark) => mark.dataset.stepMark === name);
  marks.forEach((mark, i) => {
    mark.classList.toggle("done", i < index || name === "done");
    if (i === index) mark.setAttribute("aria-current", "step");
    else mark.removeAttribute("aria-current");
  });
  document.querySelectorAll("[data-email]").forEach((node) => {
    node.textContent = state.email;
  });
}

function setFieldError(input, message) {
  const error = document.getElementById(`${input.id}-error`);
  error.textContent = message || "";
  if (message) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

function setFormError(form, message) {
  form.querySelector("[data-form-error]").textContent = message || "";
}

async function busy(form, work) {
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  form.setAttribute("aria-busy", "true");
  try {
    await work();
  } finally {
    button.disabled = false;
    form.removeAttribute("aria-busy");
  }
}

function validateAccount() {
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const problems = [
    [emailInput, !email ? "Enter your email." : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? "That doesn't look like an email address." : ""],
    [passwordInput, password.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters.` : ""],
    [confirmInput, confirmInput.value !== password ? "The passwords don't match." : ""],
  ];
  if (state.token) problems[0][1] = ""; // the address is verified and locked while she picks a new password
  problems.forEach(([input, message]) => setFieldError(input, message));
  const first = problems.find(([, message]) => message);
  if (first) {
    first[0].focus();
    return false;
  }
  return true;
}

function requestCode() {
  return api("/auth/v1/otp", {
    body: { email: state.email, create_user: true, data: { [PENDING_KEY]: "pending" } },
  });
}

function startCooldown() {
  state.cooldownUntil = Date.now() + RESEND_SECONDS * 1000;
  clearInterval(state.timer);
  const tick = () => {
    const left = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(state.timer);
      resendButton.disabled = false;
      resendButton.textContent = "Send a new code";
      return;
    }
    resendButton.disabled = true;
    resendButton.textContent = `Send a new code in 0:${String(left).padStart(2, "0")}`;
  };
  tick();
  state.timer = setInterval(tick, 1000);
}

// Sets the password of an account the code request just made, then adds her to the list. `created`: the fixed-code
// sign-up just made the account with her password.
async function finish(user, created = false) {
  const pending = user?.user_metadata?.[PENDING_KEY] === "pending";
  if (pending) {
    try {
      await api("/auth/v1/user", {
        method: "PUT",
        token: state.token,
        body: { password: state.password, data: { [PENDING_KEY]: null } },
      });
    } catch (error) {
      if (error.code !== "weak_password") throw error;
      emailInput.value = state.email;
      emailInput.readOnly = true;
      passwordInput.value = "";
      confirmInput.value = "";
      show("account");
      setFormError(accountForm, "Your email is confirmed. Now choose a stronger password to finish.");
      setFieldError(passwordInput, MESSAGES.weak_password);
      passwordInput.focus();
      return;
    }
  }
  const rows = await api("/rest/v1/rpc/join_early_access", { body: {}, token: state.token });
  const entry = Array.isArray(rows) ? rows[0] : rows;
  document.querySelector("[data-done-title]").textContent = entry?.newly_joined === false
    ? "You're already on the list!"
    : "You're on the list!";
  const note = document.querySelector("[data-done-note]");
  note.hidden = pending || created;
  note.textContent = pending ? "" : "You already have a Herfect account, so your password hasn't changed. Sign in to the app with it.";
  // scope=local ends only this page's session, so an app sign-in on the same account stays.
  api("/auth/v1/logout?scope=local", { token: state.token }).catch(() => {});
  Object.assign(state, { password: "", token: "" });
  passwordInput.value = "";
  confirmInput.value = "";
  clearInterval(state.timer);
  show("done");
  document.getElementById("done-title").focus();
}

accountForm.addEventListener("submit", (event) => {
  event.preventDefault();
  setFormError(accountForm, "");
  if (!validateAccount()) return;
  busy(accountForm, async () => {
    state.password = passwordInput.value;
    try {
      if (state.token) {
        await finish({ user_metadata: { [PENDING_KEY]: "pending" } });
        return;
      }
      state.email = emailInput.value.trim().toLowerCase();
      if (!FIXED_CODE) await requestCode();
      codeInput.value = "";
      setFieldError(codeInput, "");
      setFormError(codeForm, "");
      resendStatus.textContent = "";
      show("code");
      if (!FIXED_CODE) startCooldown();
      codeInput.focus();
    } catch (error) {
      if (state.token && error.status === 401) {
        state.token = "";
        emailInput.readOnly = false;
      }
      const message = messageFor(error);
      if (error.code === "email_address_invalid" || error.code === "validation_failed") {
        setFieldError(emailInput, message);
        emailInput.focus();
      } else {
        setFormError(accountForm, message);
      }
    }
  });
});

codeInput.addEventListener("input", () => {
  codeInput.value = codeInput.value.replace(/\D/g, "");
  setFieldError(codeInput, "");
});

codeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  setFormError(codeForm, "");
  const code = codeInput.value.replace(/\D/g, "");
  if (code.length < 6) {
    setFieldError(codeInput, FIXED_CODE ? "Enter your 6-digit code." : "Enter the 6-digit code from the email.");
    codeInput.focus();
    return;
  }
  if (FIXED_CODE) {
    joinWithFixedCode(code);
    return;
  }
  busy(codeForm, async () => {
    try {
      const session = await api("/auth/v1/verify", { body: { type: "email", email: state.email, token: code } });
      state.token = session.access_token;
      await finish(session.user);
    } catch (error) {
      if (error.code === "otp_expired") {
        setFieldError(codeInput, messageFor(error));
        codeInput.focus();
      } else {
        setFormError(codeForm, messageFor(error));
      }
    }
  });
});

// The fixed-code flow: only FIXED_CODE passes, then a password sign-up ("Confirm email" is off, so it answers with a
// session) makes the account and she joins the list. An email with an account is sent back to sign in with the app.
function joinWithFixedCode(code) {
  if (code !== FIXED_CODE) {
    setFieldError(codeInput, MESSAGES.otp_expired);
    codeInput.focus();
    return;
  }
  busy(codeForm, async () => {
    try {
      const session = await api("/auth/v1/signup", { body: { email: state.email, password: state.password } });
      if (!session?.access_token) throw new ApiError("no_session", 200);
      state.token = session.access_token;
      await finish(session.user, true);
    } catch (error) {
      if (["user_already_exists", "email_exists", "weak_password", "email_address_invalid", "validation_failed"]
        .includes(error.code)) {
        show("account");
        if (error.code === "weak_password") {
          setFieldError(passwordInput, messageFor(error));
          passwordInput.focus();
        } else if (error.code === "email_address_invalid" || error.code === "validation_failed") {
          setFieldError(emailInput, messageFor(error));
          emailInput.focus();
        } else {
          setFormError(accountForm, messageFor(error));
        }
      } else {
        setFormError(codeForm, messageFor(error));
      }
    }
  });
}

resendButton.addEventListener("click", async () => {
  if (Date.now() < state.cooldownUntil) return;
  resendButton.disabled = true;
  resendStatus.textContent = "";
  setFormError(codeForm, "");
  try {
    await requestCode();
    resendStatus.textContent = "A new code is on its way.";
    startCooldown();
  } catch (error) {
    setFormError(codeForm, messageFor(error));
    resendButton.disabled = false;
  }
});

codeForm.querySelector("[data-change-email]").addEventListener("click", () => {
  clearInterval(state.timer);
  state.cooldownUntil = 0;
  resendButton.disabled = false;
  resendButton.textContent = "Send a new code";
  show("account");
  emailInput.focus();
  emailInput.select();
});

document.getElementById("show-password").addEventListener("change", (event) => {
  const type = event.target.checked ? "text" : "password";
  passwordInput.type = type;
  confirmInput.type = type;
});

for (const input of [emailInput, passwordInput, confirmInput]) {
  input.addEventListener("input", () => setFieldError(input, ""));
}
