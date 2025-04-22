// Server.js

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const fs = require('fs');

const OAUTH_URL = 'http://localhost:3000/auth/google/callback';
const TOKEN_JSON = './token.json';

const app = express();
app.use(express.json());
app.use(session({ 
    secret: 'secret_key', 
    resave: false, 
    saveUninitalized: true 
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

// Start OAuth process
app.get('/auth/google', (req, res) => {
    console.log("/auth/google hit");
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/photoslibrary.readonly'],
    });
    console.log("redirecting to: ", authUrl);
    res.redirect(authUrl);
});

// OAuth Callback
app.get('/auth/google/callback', async (req, res) => {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_JSON, JSON.stringify(tokens));
    res.send('Authentication successful! You can close this tab.');
});

app.listen(3000, () => console.log('Server running...')); 
