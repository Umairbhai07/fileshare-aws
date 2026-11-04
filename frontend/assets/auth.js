// Cognito Hosted UI with OAuth 2.0 Authorization Code + PKCE, no SDK needed.
const cfg = window.APP_CONFIG || { authMode: 'dev' };
const STORE = 'sharebox.tokens';
const redirectUri = () => `${location.origin}/`;

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = (n = 48) => b64url(crypto.getRandomValues(new Uint8Array(n)));

function save(tokens) {
  const prev = load() || {};
  const t = { ...prev, ...tokens, expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000 };
  localStorage.setItem(STORE, JSON.stringify(t));
  return t;
}
function load() {
  try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; }
}
function claims(jwt) {
  try { return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; }
}

async function tokenRequest(params) {
  const res = await fetch(`${cfg.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, ...params }),
  });
  if (!res.ok) throw new Error('Token request failed');
  return res.json();
}

export const auth = {
  isDev: cfg.authMode !== 'cognito',

  async login(signup = false) {
    const verifier = randomString();
    const state = randomString(16);
    sessionStorage.setItem('pkce', JSON.stringify({ verifier, state }));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const q = new URLSearchParams({
      response_type: 'code', client_id: cfg.clientId, redirect_uri: redirectUri(), scope: 'openid email profile',
      state, code_challenge: challenge, code_challenge_method: 'S256',
    });
    location.assign(`${cfg.cognitoDomain}/${signup ? 'signup' : 'oauth2/authorize'}?${q}`);
  },

  /** Handles ?code=... on return from the Hosted UI. Returns true if a login completed. */
  async handleCallback() {
    const q = new URLSearchParams(location.search);
    if (!q.get('code')) return false;
    const { verifier, state } = JSON.parse(sessionStorage.getItem('pkce') || '{}');
    history.replaceState(null, '', '/');
    if (!verifier || q.get('state') !== state) return false;
    save(await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri(), code_verifier: verifier }));
    sessionStorage.removeItem('pkce');
    return true;
  },

  async accessToken() {
    if (this.isDev) return null;
    const t = load();
    if (!t) return null;
    if (Date.now() < t.expiresAt - 60_000) return t.access_token;
    if (!t.refresh_token) return null;
    try {
      return save(await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token })).access_token;
    } catch {
      localStorage.removeItem(STORE);
      return null;
    }
  },

  async isSignedIn() {
    return this.isDev || Boolean(await this.accessToken());
  },

  user() {
    if (this.isDev) return { email: 'dev@localhost' };
    const c = claims(load()?.id_token || '');
    return { email: c.email || c['cognito:username'] || 'user' };
  },

  logout() {
    localStorage.removeItem(STORE);
    if (this.isDev) return location.reload();
    location.assign(`${cfg.cognitoDomain}/logout?${new URLSearchParams({ client_id: cfg.clientId, logout_uri: redirectUri() })}`);
  },
};
