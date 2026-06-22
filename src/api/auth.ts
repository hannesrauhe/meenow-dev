// OAuth PKCE auth: client registration, login flow, token/accountId storage, and auth state helpers.
import { clearPushSubFilename } from '../state';

const PREFIX = 'meenow:auth:';

export interface AuthState {
  instance: string;
  accessToken: string;
  accountId: string;
}

function key(instance: string, field: string): string {
  return `${PREFIX}${instance}:${field}`;
}

function currentRedirectUri(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

function randomBase64Url(bytes: number): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function sha256Base64Url(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function ensureAppRegistered(instance: string): Promise<{ clientId: string; clientSecret: string }> {
  const stored = localStorage.getItem(key(instance, 'creds'));
  if (stored) return JSON.parse(stored) as { clientId: string; clientSecret: string };

  const res = await fetch(`https://${instance}/api/v1/apps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'meenow',
      redirect_uris: currentRedirectUri(),
      scopes: 'read write',
      website: currentRedirectUri(),
    }),
  });
  if (!res.ok) throw new Error(`App registration failed (${res.status}). Check the instance name.`);

  const data = await res.json() as { client_id: string; client_secret: string };
  const creds = { clientId: data.client_id, clientSecret: data.client_secret };
  localStorage.setItem(key(instance, 'creds'), JSON.stringify(creds));
  return creds;
}

export async function startOAuthFlow(instance: string): Promise<void> {
  const creds = await ensureAppRegistered(instance);
  const verifier = randomBase64Url(32);
  const challenge = await sha256Base64Url(verifier);

  localStorage.setItem(`${PREFIX}verifier`, verifier);
  localStorage.setItem(`${PREFIX}pending-instance`, instance);

  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: currentRedirectUri(),
    response_type: 'code',
    scope: 'read write',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  window.location.href = `https://${instance}/oauth/authorize?${params}`;
}

export async function handleOAuthCallback(code: string): Promise<void> {
  const instance = localStorage.getItem(`${PREFIX}pending-instance`);
  const verifier = localStorage.getItem(`${PREFIX}verifier`);
  if (!instance || !verifier) throw new Error('No pending OAuth session');

  const creds = await ensureAppRegistered(instance);

  const tokenRes = await fetch(`https://${instance}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: currentRedirectUri(),
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) throw new Error(`Token exchange failed (${tokenRes.status})`);

  const { access_token } = await tokenRes.json() as { access_token: string };
  localStorage.removeItem(`${PREFIX}verifier`);
  localStorage.setItem(key(instance, 'token'), access_token);
  localStorage.setItem(`${PREFIX}instance`, instance);

  const meRes = await fetch(`https://${instance}/api/v1/accounts/verify_credentials`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!meRes.ok) throw new Error('Could not verify credentials');
  const { id } = await meRes.json() as { id: string };
  localStorage.setItem(key(instance, 'accountId'), id);
}

export function getAuthState(): AuthState | null {
  const instance = localStorage.getItem(`${PREFIX}instance`);
  if (!instance) return null;
  const accessToken = localStorage.getItem(key(instance, 'token'));
  if (!accessToken) return null;
  const accountId = localStorage.getItem(key(instance, 'accountId')) ?? '';
  return { instance, accessToken, accountId };
}

export function patchAccountId(instance: string, accountId: string): void {
  localStorage.setItem(key(instance, 'accountId'), accountId);
}

export function clearAuth(): void {
  const instance = localStorage.getItem(`${PREFIX}instance`);
  if (instance) {
    localStorage.removeItem(key(instance, 'token'));
    localStorage.removeItem(key(instance, 'accountId'));
    localStorage.removeItem(key(instance, 'creds'));
  }
  localStorage.removeItem(`${PREFIX}instance`);
  localStorage.removeItem(`${PREFIX}pending-instance`);
  localStorage.removeItem(`${PREFIX}verifier`);
  clearPushSubFilename();
  localStorage.removeItem('meenow:pwa-subbed');
}
