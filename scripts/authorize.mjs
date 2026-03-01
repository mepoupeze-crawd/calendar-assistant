/**
 * One-time OAuth2 authorization script.
 * Run once to get a refresh token, then never again.
 *
 * Usage:
 *   node scripts/authorize.mjs
 *
 * Prerequisites:
 *   - credentials/oauth-client.json downloaded from Google Cloud Console
 *     (OAuth 2.0 Client ID → Desktop app)
 */

import { google } from 'googleapis';
import { readFileSync, existsSync, readFileSync as rf } from 'fs';
import { createServer } from 'http';
import { URL } from 'url';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CREDS_FILE = path.join(ROOT, 'credentials', 'oauth-client.json');
const ENV_FILE = path.join(ROOT, '.env');

if (!existsSync(CREDS_FILE)) {
  console.error('❌ credentials/oauth-client.json not found.');
  console.error('Download it from Google Cloud Console → Credentials → OAuth 2.0 Client IDs → Desktop app');
  process.exit(1);
}

const creds = JSON.parse(readFileSync(CREDS_FILE, 'utf8'));
const { client_id, client_secret } = creds.installed ?? creds.web;
const PORT = 3030;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const oauth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/contacts.readonly',
  ],
  prompt: 'consent', // force refresh_token even if previously authorized
});

console.log('\n📋 Opening browser for authorization...');
console.log('If the browser does not open, paste this URL manually:\n');
console.log(authUrl);
console.log();

// Try to open the browser
try {
  execSync(`start "" "${authUrl}"`, { stdio: 'ignore' });
} catch {
  // ignore — user will open manually
}

// Start local server to catch the OAuth callback
await new Promise((resolve, reject) => {
  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    if (reqUrl.pathname !== '/callback') {
      res.end('Not found');
      return;
    }

    const code = reqUrl.searchParams.get('code');
    const error = reqUrl.searchParams.get('error');

    if (error) {
      res.writeHead(400);
      res.end(`❌ Authorization failed: ${error}`);
      server.close();
      reject(new Error(error));
      return;
    }

    if (!code) {
      res.writeHead(400);
      res.end('❌ No code received');
      server.close();
      reject(new Error('No code in callback'));
      return;
    }

    try {
      const { tokens } = await oauth2Client.getToken(code);

      if (!tokens.refresh_token) {
        res.writeHead(400);
        res.end('❌ No refresh token — revoke app access in Google Account settings and try again');
        server.close();
        reject(new Error('No refresh_token in response'));
        return;
      }

      // Write to .env
      let envContent = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
      const lines = envContent.split('\n').filter(l => !l.startsWith('GOOGLE_OAUTH_'));
      lines.push(`GOOGLE_OAUTH_CLIENT_ID=${client_id}`);
      lines.push(`GOOGLE_OAUTH_CLIENT_SECRET=${client_secret}`);
      lines.push(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`);
      // Remove trailing blank lines, add single newline
      const newContent = lines.filter((l, i) => l.trim() || i === lines.length - 1).join('\n') + '\n';
      import('fs').then(({ writeFileSync }) => writeFileSync(ENV_FILE, newContent));

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family:sans-serif;padding:2rem">
          <h2>✅ Authorization successful!</h2>
          <p>Refresh token saved to <code>.env</code>.</p>
          <p>You can close this tab and return to the terminal.</p>
        </body></html>
      `);

      console.log('✅ Refresh token saved to .env');
      console.log('You can now run: npm run bot\n');
      server.close();
      resolve(tokens);
    } catch (err) {
      res.writeHead(500);
      res.end(`❌ Token exchange failed: ${err.message}`);
      server.close();
      reject(err);
    }
  });

  server.listen(PORT, () => {
    console.log(`⏳ Waiting for authorization on http://localhost:${PORT}/callback ...`);
  });
});
