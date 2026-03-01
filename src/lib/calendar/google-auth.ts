/**
 * Google Calendar API — OAuth2 Authentication (refresh token)
 *
 * Setup (one-time):
 *   node scripts/authorize.mjs
 *
 * Required env vars (written automatically by authorize.mjs):
 *   GOOGLE_OAUTH_CLIENT_ID
 *   GOOGLE_OAUTH_CLIENT_SECRET
 *   GOOGLE_OAUTH_REFRESH_TOKEN
 */

import { google } from 'googleapis';

export function getGoogleAuth() {
  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Google OAuth credentials not set. Run: node scripts/authorize.mjs\n' +
      'Missing: ' +
      [!clientId && 'GOOGLE_OAUTH_CLIENT_ID', !clientSecret && 'GOOGLE_OAUTH_CLIENT_SECRET', !refreshToken && 'GOOGLE_OAUTH_REFRESH_TOKEN']
        .filter(Boolean).join(', ')
    );
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

export function getCalendarClient() {
  const auth = getGoogleAuth();
  return google.calendar({ version: 'v3', auth });
}
