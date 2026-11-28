# Step-by-Step Deployment Guide 🚀

## Phase 1: Local Setup (5 minutes)

### Step 1: Install Dependencies

```bash
cd cloudflare-worker
npm install
```

### Step 2: Get Cloudflare Account ID

```bash
wrangler whoami
```

Copy your **Account ID**

### Step 3: Create KV Namespaces

```bash
# Production namespace
wrangler kv:namespace create BOT_KV

# Preview/Development namespace
wrangler kv:namespace create BOT_KV --preview
```

You'll see output like:
```
✓ Successfully created kv namespace with id: a1b2c3d4e5f6g7h8
```

Copy both IDs.

---

## Phase 2: Configure (3 minutes)

### Step 4: Update wrangler.toml

Open `wrangler.toml` and replace:

```toml
account_id = "YOUR_ACCOUNT_ID_HERE"  # Replace with your ID

[[kv_namespaces]]
binding = "BOT_KV"
id = "YOUR_KV_NAMESPACE_ID"          # Replace with production ID
preview_id = "YOUR_PREVIEW_KV_ID"    # Replace with preview ID
```

Example:
```toml
account_id = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"

[[kv_namespaces]]
binding = "BOT_KV"
id = "xyz123abc456def789ghi"
preview_id = "preview_xyz123abc456def789"
```

### Step 5: Test Locally

```bash
npm run dev
```

Visit `http://localhost:8787/health`

You should see:
```json
{
  "status": "ok",
  "service": "June Bot - Cloudflare Workers",
  "timestamp": "...",
  "version": "1.0.0"
}
```

Press `Ctrl+C` to stop.

---

## Phase 3: Deploy (2 minutes)

### Step 6: Deploy to Cloudflare

```bash
npm run deploy
```

You'll see:
```
✓ Successfully published your Worker to june-bot-cf.devmarisel.workers.dev
```

Your bot URL: `https://june-bot-cf.devmarisel.workers.dev`

---

## Phase 4: Test Deployment (5 minutes)

### Step 7: Test Health Endpoint

```bash
curl https://june-bot-cf.devmarisel.workers.dev/health
```

### Step 8: Test Pairing

```bash
curl -X POST https://june-bot-cf.devmarisel.workers.dev/pair \
  -H "Content-Type: application/json" \
  -d '{"phone": "1234567890"}'
```

You should get a 6-digit code like:
```json
{
  "success": true,
  "pairingCode": "123456",
  "phone": "1234567890",
  "expiresIn": "10 minutes",
  "instructions": [
    "1. Open WhatsApp on your phone",
    "..."
  ]
}
```

### Step 9: Test Message Processing

```bash
curl -X POST https://june-bot-cf.devmarisel.workers.dev/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "message": "!ping",
    "from": "1234567890@s.whatsapp.net",
    "chatId": "1234567890@s.whatsapp.net"
  }'
```

Expected response:
```json
{
  "success": true,
  "messageId": "msg_1234567890_abc123",
  "from": "1234567890@s.whatsapp.net",
  "originalMessage": "!ping",
  "botResponse": "🏓 Pong!",
  "timestamp": "..."
}
```

### Step 10: Test Bot Status

```bash
curl https://june-bot-cf.devmarisel.workers.dev/status
```

---

## Phase 5: Connect to WhatsApp (10 minutes)

### Step 11: WhatsApp Pairing

1. **Get Pairing Code**
   ```bash
   curl -X POST https://june-bot-cf.devmarisel.workers.dev/pair \
     -H "Content-Type: application/json" \
     -d '{"phone": "YOUR_PHONE_NUMBER"}'
   ```

2. **Open WhatsApp on Phone**
   - Go to: Settings → Linked Devices
   - Tap: "Link a Device"
   - Tap: "Link a Device" again

3. **Enter Pairing Code**
   - Enter the 6-digit code received above
   - You have 10 minutes

4. **Verify Connection**
   ```bash
   curl https://june-bot-cf.devmarisel.workers.dev/status
   ```
   Should show: `"status": "connected"`

---

## Phase 6: Add More Commands (Optional)

Edit `cloudflare-worker/src/handlers/messages.js`

Add your command in the `processCommand()` function:

```javascript
if (msg === '!mycommand') {
  return 'My custom response!';
}
```

Redeploy:
```bash
npm run deploy
```

---

## Monitoring & Maintenance 📊

### Check Deployment Status

```bash
wrangler deployments list
```

### View Worker Analytics

Go to: https://dash.cloudflare.com → Workers → june-bot-cf → Analytics

### Check KV Usage

```bash
wrangler kv:key list --namespace-id YOUR_KV_ID
```

### View Recent Messages

```bash
wrangler kv:key list --namespace-id YOUR_KV_ID --prefix msg_
```

### Clear KV Storage

```bash
wrangler kv:namespace delete BOT_KV  # Warning: deletes all data
```

---

## Troubleshooting 🔧

### Error: "Unauthorized"

```bash
wrangler login
```

### Error: "KV Namespace not found"

Update KV IDs in `wrangler.toml`

```bash
wrangler kv:namespace list
```

### Error: "Service timeout"

Cloudflare Workers have 30-second timeout. Ensure handlers respond quickly.

### Worker not updating

Clear cache and redeploy:

```bash
wrangler publish --compatibility-date 2024-01-01
```

---

## What's Next? 🚀

1. ✅ Deploy to Cloudflare
2. ✅ Test endpoints
3. ✅ Connect WhatsApp
4. ⏭️ Deploy Baileys instance (Railway/Heroku)
5. ⏭️ Integrate Baileys with this Worker
6. ⏭️ Add database layer (MongoDB/PostgreSQL)
7. ⏭️ Create admin dashboard

---

## Cost Breakdown 💰

- **Cloudflare Workers**: Free (up to 100k requests/day)
- **KV Storage**: Free (up to 1GB read/write)
- **Total Cost**: $0/month (free tier)

Upgrade options when you grow:
- Workers Paid: $0.15/10M requests
- KV Paid: $0.50/1M read, $1.00/1M write

---

**Congratulations! Your bot is live! 🎉**
