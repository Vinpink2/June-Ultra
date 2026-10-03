# June Bot - Cloudflare Workers Edition 🤖

A serverless WhatsApp bot built with Baileys and deployed on Cloudflare Workers with KV storage.

## Features ✨

- ✅ Serverless deployment (no server costs)
- ✅ Instant global distribution via Cloudflare network
- ✅ WhatsApp pairing code authentication
- ✅ KV storage for persistence
- ✅ Command-based message handling
- ✅ Message history logging
- ✅ Health checks and status monitoring

## Prerequisites 📋

- Node.js (v16+)
- npm
- Cloudflare account (free tier works)
- Wrangler CLI

## Installation & Setup 🚀

### 1. Install Wrangler CLI

```bash
npm install -g wrangler
```

### 2. Clone and Setup

```bash
cd cloudflare-worker
npm install
```

### 3. Login to Cloudflare

```bash
wrangler login
```

This will open your browser to authenticate with Cloudflare.

### 4. Create KV Namespace

```bash
wrangler kv:namespace create BOT_KV
wrangler kv:namespace create BOT_KV --preview
```

You'll receive namespace IDs. Copy them and update `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "BOT_KV"
id = "your_kv_id_here"
preview_id = "your_preview_kv_id_here"
```

### 5. Update wrangler.toml

```bash
wrangler whoami  # Get your account ID
```

Update `wrangler.toml`:

```toml
account_id = "your_account_id_here"
```

### 6. Deploy

```bash
npm run deploy
```

You'll get a URL like: `https://june-bot-cf.devmarisel.workers.dev`

## Usage 📱

### Health Check

```bash
curl https://june-bot-cf.devmarisel.workers.dev/health
```

### Start Pairing

```bash
curl -X POST https://june-bot-cf.devmarisel.workers.dev/pair \
  -H "Content-Type: application/json" \
  -d '{"phone": "1234567890"}'
```

You'll get a 6-digit pairing code. Enter it in WhatsApp:
1. Open WhatsApp
2. Settings > Linked Devices
3. Tap "Link a Device"
4. Enter the pairing code

### Check QR Status

```bash
curl https://june-bot-cf.devmarisel.workers.dev/qr
```

### Get Bot Status

```bash
curl https://june-bot-cf.devmarisel.workers.dev/status
```

### Send Test Message

```bash
curl -X POST https://june-bot-cf.devmarisel.workers.dev/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "message": "!ping",
    "from": "1234567890@s.whatsapp.net",
    "chatId": "1234567890@s.whatsapp.net"
  }'
```

## Available Commands 🎮

| Command | Response |
|---------|----------|
| `!ping` | 🏓 Pong! |
| `!help` | Show all commands |
| `!status` | Check bot status |
| `!time` | Current time |
| `!echo <text>` | Repeat your text |
| `!about` | Bot information |

## Development ��️

### Local Testing

```bash
npm run dev
```

This starts a local server at `http://localhost:8787`

### Project Structure

```
cloudflare-worker/
├── src/
│   ├── index.js           # Main router
│   └── handlers/
│       ├── health.js      # Health check
│       ├── qr.js          # QR code handling
│       ├── pair.js        # Pairing codes
│       └── messages.js    # Message processing
├── wrangler.toml          # Configuration
├── package.json           # Dependencies
└── README.md              # This file
```

## Connecting Baileys 🔗

To fully connect this with Baileys for actual WhatsApp messaging:

1. Set up a separate Node.js server running Baileys
2. Configure webhooks to send messages to this Cloudflare Worker
3. Use the pairing codes generated here to authenticate Baileys

## Limitations ⚠️

- Cloudflare Workers have a 30-second timeout
- KV storage has rate limits (free tier: 3 reads/writes per second)
- Suitable for low-traffic bots
- For high-volume, consider using Railway or Heroku

## Troubleshooting 🔧

### "Namespace ID not found"

```bash
wrangler kv:namespace list
```

Update the IDs in `wrangler.toml`

### Deployment fails

```bash
wrangler publish  # Use instead of deploy
```

### Local dev not working

```bash
wrangler dev --local  # Force local mode
```

## Security Tips 🔒

- Use HTTPS only
- Add webhook secret validation
- Rotate pairing codes regularly
- Monitor KV usage
- Set rate limits

## Next Steps 🚀

1. ✅ Deploy this worker
2. ✅ Test pairing endpoints
3. ⏭️ Connect with a Baileys instance
4. ⏭️ Add database for user preferences
5. ⏭️ Implement command plugins

## Support 💬

For issues or questions:
- GitHub: [devmarisel/June-Ultra](https://github.com/devmarisel/June-Ultra)
- Cloudflare Docs: https://developers.cloudflare.com/workers/
- Baileys: https://github.com/WhiskeySockets/Baileys

## License 📄

MIT - Feel free to use and modify!

---

**Made with ❤️ for June Bot**
