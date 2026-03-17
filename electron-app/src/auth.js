const { PublicClientApplication } = require('@azure/msal-node');
const http = require('http');

const REDIRECT_PORT = 45678;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;

const SCOPES = [
  'User.Read',
  'Mail.Read',
  'Mail.Send',
  'Calendars.ReadWrite',
  'offline_access',
];

class AuthManager {
  constructor(store) {
    this.store = store;
    this.msalApp = null;
    this.account = null;

    // Restore saved account
    const saved = store.get('msalAccount');
    if (saved) this.account = saved;
  }

  _ensureMsal() {
    const clientId = this.store.get('azureClientId');
    if (!clientId) {
      throw new Error('Azure Client ID not configured. Set it in Settings.');
    }

    const tenantId = this.store.get('azureTenantId') || 'common';

    this.msalApp = new PublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
      },
    });
  }

  async startMicrosoftAuth() {
    this._ensureMsal();

    return new Promise((resolve, reject) => {
      // Start a temporary local HTTP server to receive the OAuth callback
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);

        if (url.pathname !== '/auth/callback') {
          res.writeHead(404);
          res.end();
          return;
        }

        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(this._resultPage(false, url.searchParams.get('error_description') || error));
          server.close();
          reject(new Error(error));
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(this._resultPage(false, 'No authorization code received'));
          server.close();
          reject(new Error('No code'));
          return;
        }

        try {
          // Exchange code for tokens
          const result = await this.msalApp.acquireTokenByCode({
            code,
            scopes: SCOPES,
            redirectUri: REDIRECT_URI,
          });

          this.account = result.account;
          this.store.set('msalAccount', result.account);

          // Store tokens for the backend agents (via gateway)
          await this._saveTokensToBackend(result);

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(this._resultPage(true, `Welcome, ${result.account.name || result.account.username}!`));

          server.close();
          resolve({
            success: true,
            name: result.account.name,
            email: result.account.username,
          });
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(this._resultPage(false, err.message));
          server.close();
          reject(err);
        }
      });

      server.listen(REDIRECT_PORT, () => {
        // Build auth URL and open in default browser
        const authUrl = this.msalApp.getAuthCodeUrl({
          scopes: SCOPES,
          redirectUri: REDIRECT_URI,
        }).then(url => {
          const { shell } = require('electron');
          shell.openExternal(url);
        }).catch(err => {
          server.close();
          reject(err);
        });
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        reject(new Error('OAuth timed out'));
      }, 300000);
    });
  }

  async _saveTokensToBackend(msalResult) {
    const gatewayUrl = this.store.get('gatewayUrl');
    const userId = this.store.get('userId');

    try {
      await fetch(`${gatewayUrl}/api/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          provider: 'microsoft',
          accessToken: msalResult.accessToken,
          refreshToken: msalResult.refreshToken || null,
          expiresAt: msalResult.expiresOn?.toISOString(),
          scopes: SCOPES,
          account: {
            name: msalResult.account.name,
            email: msalResult.account.username,
          },
        }),
      });
    } catch {
      // Gateway may not have this endpoint yet — that's OK for Phase 1
      console.warn('Could not save tokens to gateway (endpoint may not exist yet)');
    }
  }

  async getStatus() {
    if (!this.account) {
      return { authenticated: false };
    }

    return {
      authenticated: true,
      name: this.account.name,
      email: this.account.username,
      provider: 'microsoft',
    };
  }

  async logout() {
    this.account = null;
    this.store.delete('msalAccount');
    return { authenticated: false };
  }

  _resultPage(success, message) {
    const color = success ? '#22c55e' : '#ef4444';
    const icon = success ? '&#10003;' : '&#10007;';
    return `<!DOCTYPE html>
<html>
<head><title>HEKLA — OAuth</title></head>
<body style="background:#0a0a0f;color:#d4d0cb;font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <div style="text-align:center">
    <div style="font-size:48px;color:${color}">${icon}</div>
    <h2 style="color:${color}">${success ? 'Connected!' : 'Error'}</h2>
    <p>${message}</p>
    <p style="color:#71717a;margin-top:24px">You can close this tab and return to HEKLA.</p>
  </div>
</body>
</html>`;
  }
}

module.exports = { AuthManager };
