import { Router } from 'itty-router';
import { handleQR } from './handlers/qr';
import { handlePair } from './handlers/pair';
import { handleMessages } from './handlers/messages';
import { handleHealth } from './handlers/health';

const router = Router();

// Health check endpoint
router.get('/health', handleHealth);

// QR Code endpoint - for scanning
router.get('/qr', handleQR);

// Pairing code endpoint
router.post('/pair', handlePair);

// Webhook for incoming messages
router.post('/webhook', handleMessages);

// Get bot status
router.get('/status', async (request, env) => {
  const botStatus = await env.BOT_KV.get('bot_status');
  return new Response(
    JSON.stringify({
      status: botStatus ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
});

// 404 handler
router.all('*', () => {
  return new Response(
    JSON.stringify({ error: 'Not Found', message: 'Endpoint does not exist' }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }
  );
});

export default {
  async fetch(request, env, ctx) {
    return router.handle(request, env, ctx);
  },
};
