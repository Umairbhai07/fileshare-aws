// Authentication against Amazon Cognito's public JSON API, straight from the browser (no SDK).
// The app client is public (no secret), so sign-up, sign-in, refresh and password reset all work
// with plain fetch calls. In local mode (authMode "dev") the same screens run against a fake backend.
const cfg = window.APP_CONFIG || { authMode: 'dev' };
const STORE = 'sharebox.session';
const isDev = cfg.authMode !== 'cognito';
const endpoint = () => `https://cognito-idp.${cfg.region}.amazonaws.com/`;

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const FRIENDLY = {
  NotAuthorizedException: 'Incorrect email or password.',
  UserNotFoundException: 'Incorrect email or password.',
  UsernameExistsException: 'An account with this email already exists. Try signing in.',
  CodeMismatchException: 'That code is not right. Check the email and try again.',
  ExpiredCodeException: 'That code has expired. We sent you a new one.',
  InvalidPasswordException: 'Use at least 8 characters with an uppercase letter, a lowercase letter and a number.',
  LimitExceededException: 'Too many attempts. Please wait a few minutes and try again.',
  TooManyRequestsException: 'Too many attempts. Please wait a few minutes and try again.',
  InvalidParameterException: 'Please check the details and try again.',
};

async function cognito(action, body) {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${action}` },
    body: JSON.stringify({ ClientId: cfg.clientId, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = String(data.__type || 'Error').split('#').pop();
    throw new AuthError(code, FRIENDLY[code] || data.message || 'Something went wrong. Please try again.');
  }
  return data;
}

function claims(jwt) {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))));
  } catch {
    return {};
  }
}

function load() {
  try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; }
}
function save(session) {
  localStorage.setItem(STORE, JSON.stringify(session));
  return session;
}
function fromResult(r, prev = {}) {
  return save({
    accessToken: r.AccessToken,
    idToken: r.IdToken,
    refreshToken: r.RefreshToken || prev.refreshToken,
    expiresAt: Date.now() + (r.ExpiresIn || 3600) * 1000,
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Local mode keeps a pretend user list in localStorage so every screen can be tried without AWS.
const devUsers = () => { try { return JSON.parse(localStorage.getItem('sharebox.devusers')) || {}; } catch { return {}; } };
const setDevUsers = (u) => localStorage.setItem('sharebox.devusers', JSON.stringify(u));

export const auth = {
  isDev,

  async signIn(email, password) {
    email = email.trim().toLowerCase();
    if (isDev) {
      await wait(350);
      const u = devUsers()[email];
      if (u && !u.confirmed) throw new AuthError('UserNotConfirmedException', 'Please verify your email first.');
      return save({ dev: true, email, name: u?.name || email.split('@')[0], expiresAt: Date.now() + 864e5 });
    }
    try {
      const r = await cognito('InitiateAuth', { AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password } });
      if (!r.AuthenticationResult) throw new AuthError('Challenge', 'This account needs an extra step that Sharebox does not support yet.');
      return fromResult(r.AuthenticationResult);
    } catch (err) {
      if (err.code === 'UserNotConfirmedException') throw new AuthError(err.code, 'Please verify your email first.');
      throw err;
    }
  },

  async signUp({ name, email, password }) {
    email = email.trim().toLowerCase();
    if (isDev) {
      await wait(400);
      const users = devUsers();
      if (users[email]?.confirmed) throw new AuthError('UsernameExistsException', FRIENDLY.UsernameExistsException);
      users[email] = { name, confirmed: false };
      setDevUsers(users);
      return { destination: email };
    }
    const r = await cognito('SignUp', {
      Username: email,
      Password: password,
      UserAttributes: [{ Name: 'email', Value: email }, { Name: 'name', Value: name }],
    });
    return { destination: r.CodeDeliveryDetails?.Destination || email };
  },

  async confirmSignUp(email, code) {
    email = email.trim().toLowerCase();
    if (isDev) {
      await wait(350);
      if (!/^\d{6}$/.test(code)) throw new AuthError('CodeMismatchException', FRIENDLY.CodeMismatchException);
      const users = devUsers();
      users[email] = { ...(users[email] || {}), confirmed: true };
      setDevUsers(users);
      return;
    }
    await cognito('ConfirmSignUp', { Username: email, ConfirmationCode: code });
  },

  async resendCode(email) {
    if (isDev) return wait(300);
    await cognito('ResendConfirmationCode', { Username: email.trim().toLowerCase() });
  },

  async forgotPassword(email) {
    if (isDev) return wait(350);
    await cognito('ForgotPassword', { Username: email.trim().toLowerCase() });
  },

  async resetPassword(email, code, password) {
    if (isDev) {
      await wait(350);
      if (!/^\d{6}$/.test(code)) throw new AuthError('CodeMismatchException', FRIENDLY.CodeMismatchException);
      return;
    }
    await cognito('ConfirmForgotPassword', { Username: email.trim().toLowerCase(), ConfirmationCode: code, Password: password });
  },

  async accessToken() {
    const s = load();
    if (!s) return null;
    if (s.dev) return isDev ? 'dev' : null;
    if (Date.now() < s.expiresAt - 60_000) return s.accessToken;
    if (!s.refreshToken) return null;
    try {
      const r = await cognito('InitiateAuth', { AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: s.refreshToken } });
      return fromResult(r.AuthenticationResult, s).accessToken;
    } catch {
      localStorage.removeItem(STORE);
      return null;
    }
  },

  async isSignedIn() {
    return Boolean(await this.accessToken());
  },

  user() {
    const s = load() || {};
    if (s.dev) return { email: s.email, name: s.name };
    const c = claims(s.idToken || '');
    return { email: c.email || '', name: c.name || (c.email || 'there').split('@')[0] };
  },

  async signOut() {
    const s = load();
    localStorage.removeItem(STORE);
    if (s?.accessToken && !isDev) cognito('GlobalSignOut', { AccessToken: s.accessToken }).catch(() => {});
    location.assign('/login');
  },
};

/** Password rules shared by sign-up and reset (match the Cognito user pool policy). */
export const PASSWORD_RULES = [
  { id: 'len', label: '8 or more characters', test: (p) => p.length >= 8 },
  { id: 'upper', label: 'An uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { id: 'lower', label: 'A lowercase letter', test: (p) => /[a-z]/.test(p) },
  { id: 'num', label: 'A number', test: (p) => /\d/.test(p) },
];
