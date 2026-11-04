import { $, $$, esc, icon, logoHtml } from './util.js';
import { auth, PASSWORD_RULES } from './auth.js';

const page = document.body.dataset.page;
const params = new URLSearchParams(location.search);
const next = params.get('next') && params.get('next').startsWith('/') ? params.get('next') : '/app';

const SIDE = {
  login: { h: 'Welcome back to files that clean up after themselves.', name: 'design-system-v2.fig', meta: '48 MB · shared 2h ago', big: '31', label: 'downloads' },
  signup: { h: 'Share big files. Keep nothing forever.', name: 'launch-video-final.mp4', meta: '842 MB · uploading', big: '68%', label: 'uploaded' },
  forgot: { h: 'Locked out? It takes a minute to get back in.', name: 'contract-signed.pdf', meta: '1.2 MB · password protected', big: '3/5', label: 'downloads' },
};

function shell(inner) {
  const s = SIDE[page];
  document.body.innerHTML = `
  <div class="auth">
    <div class="auth-main">
      <header class="auth-head">${logoHtml()}<a class="back" href="/">${icon('arrowLeft')} Home</a></header>
      <div class="auth-body"><div class="auth-card rise" id="card">${inner}</div></div>
    </div>
    <aside class="auth-side" aria-hidden="true">
      <p class="top">Sharebox · file sharing on AWS</p>
      <div>
        <h2>${esc(s.h)}</h2>
        <ul>
          <li>${icon('check')} Upload up to 2 GB straight to the cloud</li>
          <li>${icon('check')} Passwords, download limits and notes</li>
          <li>${icon('check')} Every file deleted within 24 hours</li>
        </ul>
        <div class="side-card float">
          <div class="h"><div><p>${esc(s.name)}</p><small>${esc(s.meta)}</small></div><div style="text-align:right"><p class="big">${esc(s.big)}</p><small>${esc(s.label)}</small></div></div>
          <div class="rows">
            <div><span>Time left</span><span class="track"><i style="--w:72%"></i></span></div>
            <div><span>Downloads</span><span class="track"><i style="--w:46%"></i></span></div>
          </div>
        </div>
      </div>
      <p class="foot">Files are encrypted at rest and removed automatically.</p>
    </aside>
  </div>`;
}

const devNote = () => (auth.isDev ? '<p class="hint" style="margin-top:14px;text-align:center">Local mode: any email and password work, and any 6-digit code verifies.</p>' : '');

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  btn.innerHTML = busy ? '<span class="spinner light"></span>' : label;
}
function showError(msg) {
  const el = $('#err');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}
function bindEyes() {
  $$('.eye').forEach((b) => b.addEventListener('click', () => {
    const input = b.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.innerHTML = icon(show ? 'eyeOff' : 'eye');
    b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  }));
}
const pwField = (id, label, auto, extra = '') => `
  <div class="field"><label class="label" for="${id}">${label}</label>
    <div class="input-wrap"><input class="input" id="${id}" type="password" autocomplete="${auto}" required placeholder="${auto === 'current-password' ? 'Your password' : 'Create a password'}">
    <button type="button" class="btn btn-ghost btn-icon eye" aria-label="Show password">${icon('eye')}</button></div>${extra}</div>`;
const rulesHtml = () => `<div class="strength" id="strength"><i></i><i></i><i></i><i></i></div>
  <ul class="rules" id="rules">${PASSWORD_RULES.map((r) => `<li data-r="${r.id}">${icon('check')}${r.label}</li>`).join('')}</ul>`;
function bindRules(input) {
  const update = () => {
    const passed = PASSWORD_RULES.filter((r) => r.test(input.value));
    $('#strength').className = `strength s${passed.length}`;
    PASSWORD_RULES.forEach((r) => $(`[data-r="${r.id}"]`).classList.toggle('ok', r.test(input.value)));
  };
  input.addEventListener('input', update);
  update();
}
const strongEnough = (p) => PASSWORD_RULES.every((r) => r.test(p));

function codeBoxes() {
  return `<div class="code-boxes" id="code">${Array.from({ length: 6 }, (_, i) => `<input inputmode="numeric" maxlength="1" aria-label="Digit ${i + 1}" autocomplete="${i === 0 ? 'one-time-code' : 'off'}">`).join('')}</div>`;
}
function bindCode(onComplete) {
  const boxes = $$('#code input');
  boxes.forEach((b, i) => {
    b.addEventListener('input', () => {
      b.value = b.value.replace(/\D/g, '').slice(-1);
      if (b.value && i < 5) boxes[i + 1].focus();
      if (boxes.every((x) => x.value)) onComplete?.();
    });
    b.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !b.value && i > 0) boxes[i - 1].focus(); });
    b.addEventListener('paste', (e) => {
      const digits = (e.clipboardData.getData('text').match(/\d/g) || []).slice(0, 6);
      if (!digits.length) return;
      e.preventDefault();
      digits.forEach((d, j) => { boxes[j].value = d; });
      boxes[Math.min(digits.length, 5)].focus();
      if (digits.length === 6) onComplete?.();
    });
  });
  boxes[0].focus();
  return () => boxes.map((b) => b.value).join('');
}

// ------------------------------------------------------------------------------ sign in
function renderLogin() {
  const notice = sessionStorage.getItem('sharebox.notice');
  sessionStorage.removeItem('sharebox.notice');
  shell(`
    <h1>Welcome back</h1>
    <p class="sub">Sign in to manage your files and links.</p>
    <form id="f" novalidate>
      ${notice ? `<div class="alert ok" style="margin-bottom:16px">${esc(notice)}</div>` : ''}
      <div class="alert hidden" id="err" role="alert" style="margin-bottom:16px"></div>
      <div class="field"><label class="label" for="email">Email</label><input class="input" id="email" type="email" autocomplete="email" required placeholder="you@company.com" value="${esc(params.get('email') || '')}"></div>
      ${pwField('pw', 'Password', 'current-password')}
      <div class="row-end"><a href="/forgot">Forgot password?</a></div>
      <button class="btn btn-dark" id="go" type="submit">Sign in</button>
    </form>
    <p class="alt">New here? <a href="/signup">Create an account</a></p>
    ${devNote()}`);
  bindEyes();
  (params.get('email') ? $('#pw') : $('#email')).focus();
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#email').value;
    const pw = $('#pw').value;
    if (!email || !pw) return showError('Enter your email and password.');
    const btn = $('#go');
    setBusy(btn, true);
    showError('');
    try {
      await auth.signIn(email, pw);
      location.assign(next);
    } catch (err) {
      if (err.code === 'UserNotConfirmedException') {
        sessionStorage.setItem('sharebox.verify', JSON.stringify({ email }));
        await auth.resendCode(email).catch(() => {});
        return location.assign('/signup?step=verify');
      }
      showError(err.message);
      setBusy(btn, false, 'Sign in');
    }
  };
}

// ------------------------------------------------------------------------------ sign up
function renderSignup() {
  if (params.get('step') === 'verify') return renderVerify(JSON.parse(sessionStorage.getItem('sharebox.verify') || '{}'));
  shell(`
    <h1>Create your account</h1>
    <p class="sub">Free forever. Takes less than a minute.</p>
    <form id="f" novalidate>
      <div class="alert hidden" id="err" role="alert" style="margin-bottom:16px"></div>
      <div class="field"><label class="label" for="name">Full name</label><input class="input" id="name" autocomplete="name" required placeholder="Haya Khan"></div>
      <div class="field"><label class="label" for="email">Email</label><input class="input" id="email" type="email" autocomplete="email" required placeholder="you@company.com"></div>
      ${pwField('pw', 'Password', 'new-password', rulesHtml())}
      <label class="check"><input type="checkbox" id="terms"> <span>I understand files are deleted automatically within 24 hours.</span></label>
      <button class="btn btn-dark" id="go" type="submit">Create account</button>
    </form>
    <p class="alt">Already have an account? <a href="/login">Sign in</a></p>
    ${devNote()}`);
  bindEyes();
  bindRules($('#pw'));
  $('#name').focus();
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('#name').value.trim();
    const email = $('#email').value.trim();
    const pw = $('#pw').value;
    if (!name || !email) return showError('Enter your name and email.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showError('Enter a valid email address.');
    if (!strongEnough(pw)) return showError('Your password needs to meet all four rules.');
    if (!$('#terms').checked) return showError('Please tick the box to continue.');
    const btn = $('#go');
    setBusy(btn, true);
    showError('');
    try {
      await auth.signUp({ name, email, password: pw });
      // Only the email survives a reload; the password stays in memory for the automatic sign-in.
      sessionStorage.setItem('sharebox.verify', JSON.stringify({ email }));
      history.replaceState(null, '', '/signup?step=verify');
      renderVerify({ email, pw });
    } catch (err) {
      showError(err.message);
      setBusy(btn, false, 'Create account');
    }
  };
}

function renderVerify({ email, pw }) {
  if (!email) return location.replace('/signup');
  shell(`
    <div class="logo-mark" style="width:44px;height:44px;margin-bottom:20px">${icon('mail')}</div>
    <h1>Check your email</h1>
    <p class="sub">We sent a 6-digit code to <b style="color:var(--ink)">${esc(email)}</b>.</p>
    <form id="f" novalidate>
      <div class="alert hidden" id="err" role="alert" style="margin-bottom:16px"></div>
      <label class="label">Verification code</label>
      ${codeBoxes()}
      <button class="btn btn-dark" id="go" type="submit">Verify and continue</button>
    </form>
    <p class="alt">Didn't get it? <a href="#" id="resend">Send a new code</a></p>
    ${devNote()}`);
  const read = bindCode(() => $('#f').requestSubmit());
  let cooldown = 0;
  $('#resend').onclick = async (e) => {
    e.preventDefault();
    if (cooldown > 0) return;
    await auth.resendCode(email).catch((err) => showError(err.message));
    cooldown = 30;
    const a = $('#resend');
    const t = setInterval(() => {
      cooldown -= 1;
      a.textContent = cooldown > 0 ? `Resend in ${cooldown}s` : 'Send a new code';
      if (cooldown <= 0) clearInterval(t);
    }, 1000);
  };
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const code = read();
    if (code.length !== 6) return showError('Enter all 6 digits.');
    const btn = $('#go');
    setBusy(btn, true);
    showError('');
    try {
      await auth.confirmSignUp(email, code);
      sessionStorage.removeItem('sharebox.verify');
      if (pw) {
        await auth.signIn(email, pw);
        location.assign('/app?welcome=1');
      } else {
        sessionStorage.setItem('sharebox.notice', 'Email verified. You can sign in now.');
        location.assign(`/login?email=${encodeURIComponent(email)}`);
      }
    } catch (err) {
      showError(err.message);
      setBusy(btn, false, 'Verify and continue');
    }
  };
}

// ------------------------------------------------------------------------------ forgot password
function renderForgot() {
  shell(`
    <h1>Reset your password</h1>
    <p class="sub">Enter your email and we'll send you a code.</p>
    <form id="f" novalidate>
      <div class="alert hidden" id="err" role="alert" style="margin-bottom:16px"></div>
      <div class="field"><label class="label" for="email">Email</label><input class="input" id="email" type="email" autocomplete="email" required placeholder="you@company.com"></div>
      <button class="btn btn-dark" id="go" type="submit">Send reset code</button>
    </form>
    <p class="alt">Remembered it? <a href="/login">Back to sign in</a></p>
    ${devNote()}`);
  $('#email').focus();
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#email').value.trim();
    if (!email) return showError('Enter your email.');
    const btn = $('#go');
    setBusy(btn, true);
    try {
      await auth.forgotPassword(email);
      renderReset(email);
    } catch (err) {
      showError(err.message);
      setBusy(btn, false, 'Send reset code');
    }
  };
}

function renderReset(email) {
  shell(`
    <h1>Choose a new password</h1>
    <p class="sub">Enter the code we sent to <b style="color:var(--ink)">${esc(email)}</b>.</p>
    <form id="f" novalidate>
      <div class="alert hidden" id="err" role="alert" style="margin-bottom:16px"></div>
      <label class="label">Reset code</label>
      ${codeBoxes()}
      <div style="height:16px"></div>
      ${pwField('pw', 'New password', 'new-password', rulesHtml())}
      <button class="btn btn-dark" id="go" type="submit">Update password</button>
    </form>
    <p class="alt"><a href="/login">Back to sign in</a></p>
    ${devNote()}`);
  bindEyes();
  bindRules($('#pw'));
  const read = bindCode(() => $('#pw').focus());
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const code = read();
    const pw = $('#pw').value;
    if (code.length !== 6) return showError('Enter all 6 digits of the code.');
    if (!strongEnough(pw)) return showError('Your new password needs to meet all four rules.');
    const btn = $('#go');
    setBusy(btn, true);
    try {
      await auth.resetPassword(email, code, pw);
      sessionStorage.setItem('sharebox.notice', 'Password updated. Sign in with your new password.');
      location.assign(`/login?email=${encodeURIComponent(email)}`);
    } catch (err) {
      showError(err.message);
      setBusy(btn, false, 'Update password');
    }
  };
}

(async () => {
  if (page !== 'forgot' && params.get('step') !== 'verify' && (await auth.isSignedIn())) return location.replace(next);
  ({ login: renderLogin, signup: renderSignup, forgot: renderForgot })[page]();
})();
