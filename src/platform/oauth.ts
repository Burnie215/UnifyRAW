/**
 * Browser-based OAuth 2.0 PKCE flow via popup window.
 * Works without a backend — token exchange happens client-side.
 */

interface OAuthProvider {
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  /** Extra params for the auth request */
  extraParams?: Record<string, string>;
}

export const OAUTH_PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: '', // User must set via settings
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    extraParams: { access_type: 'offline', prompt: 'consent' },
  },
  dropbox: {
    authUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    clientId: '', // User must set via settings
    scopes: [],
    extraParams: { token_access_type: 'offline' },
  },
  microsoft: {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    clientId: '', // User must set via settings
    scopes: ['Files.Read', 'offline_access'],
  },
} satisfies Record<string, OAuthProvider>;

export type OAuthProviderName = keyof typeof OAUTH_PROVIDERS;

export interface OAuthResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

/** Generate PKCE code verifier + challenge */
async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = base64UrlEncode(array);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(hash));
  return { verifier, challenge };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Start OAuth flow in a popup, return the access token.
 * The popup redirects back to /oauth-callback.html which posts the code back.
 */
export async function startOAuthFlow(
  providerName: OAuthProviderName,
  clientId: string,
): Promise<OAuthResult> {
  const provider = { ...OAUTH_PROVIDERS[providerName], clientId };
  if (!clientId) throw new Error('OAuth Client ID is required');

  const { verifier, challenge } = await generatePKCE();
  const redirectUri = `${window.location.origin}/oauth-callback.html`;
  const state = crypto.randomUUID();

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(provider.scopes.length > 0 ? { scope: provider.scopes.join(' ') } : {}),
    ...('extraParams' in provider ? provider.extraParams : {}),
  });

  const authFullUrl = `${provider.authUrl}?${params}`;

  // Open popup
  const popup = window.open(authFullUrl, 'oauth', 'width=600,height=700,popup=yes');
  if (!popup) throw new Error('Popup blocked — please allow popups for this site');

  // Wait for callback message
  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('OAuth timeout (2 min)'));
    }, 120000);

    function handler(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== 'oauth-callback') return;
      if (event.data.state !== state) return;

      window.removeEventListener('message', handler);
      clearTimeout(timeout);

      if (event.data.error) {
        reject(new Error(event.data.error));
      } else {
        resolve(event.data.code as string);
      }
    }

    window.addEventListener('message', handler);

    // Poll for popup close
    const pollClose = setInterval(() => {
      if (popup.closed) {
        clearInterval(pollClose);
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        reject(new Error('OAuth cancelled'));
      }
    }, 500);
  });

  // Exchange code for token
  const tokenParams = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });

  const tokenRes = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenParams.toString(),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  const tokenData = await tokenRes.json();
  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresIn: tokenData.expires_in,
  };
}
