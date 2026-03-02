/**
 * One-time OAuth2 helper to get a refresh token for tecnoreuniones@gmail.com.
 *
 * Usage:
 *   1. Go to https://console.cloud.google.com/apis/credentials (project clawdbot-488821)
 *   2. Create an OAuth2 Client ID (type: Desktop app)
 *   3. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local
 *   4. Run:  node --env-file=.env.local scripts/google-auth.mjs
 *   5. Open the URL in a browser, sign in as tecnoreuniones@gmail.com, paste the code
 *   6. Copy the refresh_token into .env.local → GOOGLE_REFRESH_TOKEN
 */

import { google } from 'googleapis';
import { createInterface } from 'node:readline';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌ Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local first.\n');
  console.log('Steps:');
  console.log('  1. Go to https://console.cloud.google.com/apis/credentials');
  console.log('  2. Select project "clawdbot-488821"');
  console.log('  3. Click "+ CREATE CREDENTIALS" → "OAuth client ID"');
  console.log('  4. Application type: "Desktop app", Name: "Transcriptor"');
  console.log('  5. Copy Client ID and Client Secret into .env.local');
  console.log('  6. Run this script again.\n');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/gmail.modify',
  ],
});

console.log('\n🔗 Open this URL in your browser and sign in as tecnoreuniones@gmail.com:\n');
console.log(authUrl);
console.log('');

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question('📋 Paste the authorization code here: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2.getToken(code.trim());
    console.log('\n✅ Success! Add this to your .env.local:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('');
    if (tokens.access_token) {
      console.log(`(Access token: ${tokens.access_token.substring(0, 30)}...)`);
    }
  } catch (err) {
    console.error('\n❌ Failed to exchange code:', err.message);
  }
});
