// Server.js

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require ('axios');
const { google } = require('googleapis');
const fs = require('fs');

const OAUTH_URL = 'http://localhost:3000/auth/google/callback';
const TOKEN_JSON = './token.json';

const app = express();
app.use(express.json());
app.use(session({ 
    secret: 'secret_key', 
    resave: false, 
    saveUninitalized: false 
}));

// Load the OAuth2 configuration
const oauth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    OAUTH_URL
);

// Load saved token (if it exists)
if (fs.existsSync(TOKEN_JSON)) {
    oauth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_JSON)));
}

// Ensure we are authenticated
function ensureAuth(req, res, next) {
    const creds = oauth2Client.credentials;
    if (!creds || !creds.access_token) {
        return res.redirect('/auth/google');
    }
    next();
}

// Start OAuth process
app.get('/auth/google', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/photospicker.mediaitems.readonly'],
    });
    res.redirect(authUrl);
});

// OAuth Callback storing tokens and redirecting
app.get('/auth/google/callback', async (req, res) => {
    try { 
        const { tokens } = await oauth2Client.getToken(req.query.code);
        oauth2Client.setCredentials(tokens);
        fs.writeFileSync(TOKEN_JSON, JSON.stringify(tokens, null, 2));
        return res.redirect('/picker'); } 
    catch (error) { 
        console.error('CALLBACK ERROR:', error); 
        return res.status(500).send(`<pre>${error.message}</pre>`); 
    } 
});

// Create a new Picker Session
app.post('/picker/sessions', ensureAuth, async (req, res) => {
    const token = oauth2Client.credentials.access_token;
    try {
        const { data } = await axios.post(
            'https://photospicker.googleapis.com/v1/sessions',
            {}, //No body unless we restrict to an album
            { headers: { Authorization: `Bearer ${token}`} }
        );
        return res.json(data);
    }
    catch (error) {
        console.error('sessions.create failed: ', error.response?.data);
        return res.status(500).json({error: 'Could not create Picker session' });
    }
});

// Poll a picker session's status
app.get('/picker/sessions/:sessionId', ensureAuth, async (req, res) => {
    const sessionId = req.params.sessionId;
    console.log(`=> GET /picker/sessions${sessionId}`);

    try {
        const accessTokenRes = await oauth2Client.getAccessToken();
        const token = accessTokenRes.token;
        console.log('=> Using access token: ', token);

        if (!token) {
            console.log('X No token Available');
            return res.status(401).json({ error: 'No access token available' });
        }
        const url = `https://photospicker.googleapis.com/v1/sessions/${sessionId}`;
        const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${token}`}});
        console.log('=> Sessions.get succeeded: ', data);
        return res.json(data);
    }
    catch (error) {
        console.error('X sessions.get failed: body = ', error.response?.data);
        console.error('X sessions.get failed: status = ', error.response?.status);
        return res
            .status(error.response?.status || 500)
            .json(error.response?.data || { error: error.message });
    }
});

// Fetch picked items
app.get('/picker/mediaItems', ensureAuth, async (req, res) => {
  const token = oauth2Client.credentials.access_token;
  const sessionId = req.query.sessionId;
  try {
    const { data } = await axios.get(
      `https://photospicker.googleapis.com/v1/mediaItems?sessionId=${sessionId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    // data.mediaItems is your array of selected photos/videos :contentReference[oaicite:1]{index=1}
    return res.json(data.mediaItems || []);
  } catch (err) {
    console.error('mediaItems.list failed:', err.response?.data);
    return res.status(500).json({ error: 'Could not list media items' });
  }
});

// Temp Frontend
app.get('/picker', ensureAuth, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><title>Google Photos Picker</title></head>
    <body>
      <button id="start">Pick from Google Photos</button>
      <pre id="output"></pre>
      <script>
        document.getElementById('start').onclick = async () => {
          // 1) Create session
          const sess = await fetch('/picker/sessions', { method: 'POST' })
                             .then(r => r.json());
          
          // 2) Redirect user into the Picker experience
          window.location.href = sess.pickerUri;
          
          // 3) Poll until they finish picking
          const poll = async () => {
            const info = await fetch('/picker/sessions/' + sess.id)
                                .then(r => r.json());
            if (!info.mediaItemsSet) {
              setTimeout(poll, info.recommendedPollingIntervalMillis || 1000);
            } else {
              // 4) Fetch the chosen items
              const items = await fetch('/picker/mediaItems?sessionId=' + sess.id)
                                  .then(r => r.json());
              document.getElementById('output').textContent =
                JSON.stringify(items, null, 2);
            }
          };
          poll();
        };
      </script>
    </body></html>
  `);
});

// List Albums
app.get('/albums', ensureAuth, async (req, res) => {
    const token = oauth2Client.credentials.access_token;
    if (!token) {
        return res.redirect('/auth/google');
    }

    try {
        const { data } = await axios.get(
            'https://photoslibrary.googleapis.com/v1/albums',
            { headers: { Authorization: `Bearer ${token}` }}
        );
        const albums = data.albums || [];
        return res.send(`
          <h1>Your Google Photos Albums</h1>
          <ul>
            ${albums
              .map(
                (a) =>
                  `<li>
                     <strong>${a.title}</strong><br/>
                     ID: <code>${a.id}</code><br/>
                     <a href="/api/album/${a.id}">View photos in this album</a>
                   </li>`
              )
              .join('')}
          </ul>
        `);
    }
    catch (error) {
        console.error('Album List Failed', error);
        return res.status(500).send(`<pre>${JSON.stringify(error.response?.data, null, 2)}</pre>`);
    }

});
//
// look at this later
app.get('/api/album/:albumId', ensureAuth, async (req, res) => {
  const albumId = req.params.albumId;
  const token = oauth2Client.credentials.access_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const { data } = await axios.post(
      'https://photoslibrary.googleapis.com/v1/mediaItems:search',
      { albumId, pageSize: 100 },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    return res.json(data.mediaItems || []);
  } catch (err) {
    console.error('MediaItems.search failed:', err.response?.status, err.response?.data);
    return res.status(err.response?.status || 500).json({ error: err.response?.data?.error?.message });
  }
});

// Get Media from Album
async function getAlbums(accessToken) {
    try {
        const response = await axios.get(
            'https://photoslibrary.googleapis.com/v1/albums',
            {
                headers : {
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );
        return response.data.albums || [];
    }
    catch (error) {
        console.error('Status: ', error.response?.status);
        console.error('Body: ', JSON.stringify(error.response?.data, null, 2));
        throw error;
    }
}

app.listen(3000, () => console.log('Server running...')); 
