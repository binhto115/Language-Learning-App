import 'dotenv/config';
import express from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY!;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET!;
const LIVEKIT_URL = process.env.LIVEKIT_URL!;

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
  console.error('Missing LIVEKIT_API_KEY, LIVEKIT_API_SECRET, or LIVEKIT_URL');
  process.exit(1);
}

const app = express();

// Serve static web files
app.use(express.static(join(__dirname, '..', 'web')));

// Token endpoint
app.get('/api/token', async (req, res) => {
  const room = (req.query.room as string) || 'habla-session';
  const identity = (req.query.identity as string) || 'learner';

  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name: identity,
    ttl: '1h',
  });

  token.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const jwt = await token.toJwt();

  res.json({ token: jwt, url: LIVEKIT_URL });
});

// LiveKit URL endpoint (for client reference)
app.get('/api/livekit-url', (_req, res) => {
  res.json({ url: LIVEKIT_URL });
});

app.listen(PORT, () => {
  console.log(`Token server running on http://localhost:${PORT}`);
  console.log(`LiveKit URL: ${LIVEKIT_URL}`);
});
