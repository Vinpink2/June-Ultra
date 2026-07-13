require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');
const express = require('express');
const os = require('os');

// ========== EXPRESS DASHBOARD ==========
const app = express();
const PORT = process.env.PORT || 5000;
const START_TIME = Date.now();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Platform detection
const detectPlatform = () => {
    if (process.env.DYNO) return '☁️ Heroku';
    if (process.env.RENDER) return '⚡ Render';
    if (process.env.PREFIX && process.env.PREFIX.includes('termux')) return '📱 Termux';
    if (process.env.PORTS && process.env.CYPHERX_HOST_ID) return '🌀 CypherX Platform';
    if (process.env.P_SERVER_UUID) return '🖥️ Panel';
    if (process.env.LXC) return '📦 Linux Container (LXC)';
    switch (os.platform()) {
        case 'win32': return '🪟 Windows';
        case 'darwin': return '🍎 macOS';
        case 'linux': return '🐧 Linux';
        default: return '❓ Unknown';
    }
};

// ========== PAIRING STATE + BOT PROCESS ==========
let pairState = {
    status: 'idle',     // idle | pairing | connected | failed
    code: null,
    phone: null,
    error: null,
};
let botRepoPath    = null;   // set once the zip is extracted

// Stable workspace-level backup so session survives bot folder wipes/re-extractions
const SESSION_BACKUP_DIR = path.join(__dirname, '.session_backup');

function saveSessionBackup(srcDir) {
    try {
        fs.mkdirSync(SESSION_BACKUP_DIR, { recursive: true });
        for (const f of fs.readdirSync(srcDir)) {
            fs.copyFileSync(path.join(srcDir, f), path.join(SESSION_BACKUP_DIR, f));
        }
        console.log('[ SESSION ] Backup saved to .session_backup/');
    } catch (e) {
        console.error('[ SESSION ] Backup failed:', e.message);
    }
}

function restoreSessionBackup(destDir) {
    if (!fs.existsSync(SESSION_BACKUP_DIR)) return false;
    const files = fs.readdirSync(SESSION_BACKUP_DIR);
    if (!files.length) return false;
    try {
        fs.mkdirSync(destDir, { recursive: true });
        for (const f of files) {
            fs.copyFileSync(path.join(SESSION_BACKUP_DIR, f), path.join(destDir, f));
        }
        console.log('[ SESSION ] Restored from .session_backup/');
        return true;
    } catch (e) {
        console.error('[ SESSION ] Restore failed:', e.message);
        return false;
    }
}

// Persist the "connected" pairing state across restarts so the dashboard keeps
// showing the Logout/Disconnect option instead of reverting to the pairing form.
const STATE_FILE = path.join(__dirname, 'pair_state.json');

function savePairState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(pairState, null, 2));
    } catch (e) {
        console.error('[ STATE ] Failed to save pair state:', e.message);
    }
}

function clearPairState() {
    try { if (fs.existsSync(STATE_FILE)) fs.rmSync(STATE_FILE); } catch {}
}

function loadPairState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        // Only trust a saved "connected" state if the underlying WhatsApp
        // credentials are still on disk -- otherwise fall back to idle.
        if (saved.status === 'connected' && fs.existsSync(AUTH_DIR)) {
            pairState = saved;
            console.log('[ STATE ] Restored connected session for ' + saved.phone);
        }
    } catch (e) {
        console.error('[ STATE ] Failed to load pair state:', e.message);
    }
}

// ========== SESSION GUARD ==========
// Monkey-patch fs delete operations so the bot cannot wipe its own session
// folder on restart. Any rm/unlink targeting the protected path is silently
// blocked and the file is immediately restored from our persistent backup.
function installSessionGuard(protectedDir) {
    const norm = (p) => path.resolve(String(p || ''));
    const blocked = (p) => norm(p).startsWith(norm(protectedDir));

    const _rmSync     = fs.rmSync.bind(fs);
    const _rm         = fs.rm.bind(fs);
    const _rmdirSync  = fs.rmdirSync.bind(fs);
    const _rmdir      = fs.rmdir.bind(fs);
    const _unlinkSync = fs.unlinkSync.bind(fs);
    const _unlink     = fs.unlink.bind(fs);

    fs.rmSync = (p, opts) => {
        if (blocked(p)) { console.log('[ GUARD ] Blocked rmSync on session:', String(p)); return; }
        return _rmSync(p, opts);
    };
    fs.rm = (p, opts, cb) => {
        if (blocked(p)) { console.log('[ GUARD ] Blocked rm on session:', String(p)); const fn = typeof opts === 'function' ? opts : cb; if (fn) fn(null); return; }
        return _rm(p, opts, cb);
    };
    fs.rmdirSync = (p, opts) => {
        if (blocked(p)) { console.log('[ GUARD ] Blocked rmdirSync on session:', String(p)); return; }
        return _rmdirSync(p, opts);
    };
    fs.rmdir = (p, opts, cb) => {
        if (blocked(p)) { console.log('[ GUARD ] Blocked rmdir on session:', String(p)); const fn = typeof opts === 'function' ? opts : cb; if (fn) fn(null); return; }
        return _rmdir(p, opts, cb);
    };
    fs.unlinkSync = (p) => {
        if (blocked(p)) { console.log('[ GUARD ] Blocked unlinkSync on session:', String(p)); return; }
        return _unlinkSync(p);
    };
    fs.unlink = (p, cb) => {
        if (blocked(p)) { console.log('[ GUARD ] Blocked unlink on session:', String(p)); if (cb) cb(null); return; }
        return _unlink(p, cb);
    };

    console.log('[ GUARD ] Session protection active for:', protectedDir);
}

// ========== EXIT GUARD ==========
// Block ALL process.exit() calls until the bot has actually connected to
// WhatsApp. Without this, on Heroku (no TTY stdin, no SESSION_ID) the bot's
// readline close-handler calls exit(0) immediately, crashing the dyno before
// the dashboard serves a single request.
//
// Rules:
//   exit(0)  AND botConnected=true  → allow (deliberate post-pairing restart)
//   exit(0)  AND botConnected=false → block (bot hasn't connected yet)
//   exit(>0)                        → always block (bot error, keep dashboard up)
//
// Installed immediately at module load so it covers the IIFE too.
let botConnected = false;   // flipped to true in connection-open + /api/session handlers

const _realExit = process.exit.bind(process);
process.exit = (code) => {
    const c = (code === undefined || code === null) ? 0 : Number(code);
    if (c === 0 && botConnected) {
        console.log('[ GUARD ] process.exit(0) after connect — clean restart, passing through...');
        _realExit(0);
    } else if (c === 0) {
        console.log('[ GUARD ] Blocked process.exit(0) — bot not yet connected, dashboard stays alive.');
    } else {
        console.error(`[ GUARD ] Blocked process.exit(${c}) — dashboard stays alive.`);
    }
};
console.log('[ GUARD ] Exit guard active.');

function installExitGuard() {} // no-op — guard is already installed above

function spawnBot(attempt = 1) {
    if (!botRepoPath) return;
    const MAX_ATTEMPTS = 3;
    console.log(`[ BOT ] Launching bot (attempt ${attempt}/${MAX_ATTEMPTS})...`);
    try {
        // Block error exits so the dashboard survives even when no session exists
        installExitGuard();
        // Shield the session folder from being deleted by the bot's own code
        installSessionGuard(path.join(botRepoPath, 'session'));
        // On Heroku, process.env.PORT is the port our Express server already owns.
        // If the bot's index.js also reads PORT to start its own HTTP server it
        // will get EADDRINUSE and likely call process.exit, killing the dashboard.
        // Strip PORT from the environment so the bot falls back to its own default.
        const _savedPort = process.env.PORT;
        delete process.env.PORT;
        process.chdir(botRepoPath);
        try {
            require(path.join(botRepoPath, 'index.js'));
        } finally {
            // Restore so any code in our own process still sees the real port
            if (_savedPort !== undefined) process.env.PORT = _savedPort;
        }
    } catch (err) {
        console.error(`[ BOT ] Launch error (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`);
        if (attempt < MAX_ATTEMPTS) {
            const delay = attempt * 3000; // 3s → 6s → done
            console.log(`[ BOT ] Retrying in ${delay / 1000}s...`);
            setTimeout(() => spawnBot(attempt + 1), delay);
        } else {
            console.error(`[ BOT ] All ${MAX_ATTEMPTS} launch attempts failed. Dashboard remains accessible.`);
        }
    }
}

// ========== BAILEYS PAIRING ==========
const AUTH_DIR = path.resolve(__dirname, 'auth_info_pair');
loadPairState(); // restore "connected" state (and logout option) across restarts

async function startPairing(phoneNumber) {
    // Fresh start — wipe any stale auth so we don't get instant loggedOut
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const clean = phoneNumber.replace(/\D/g, '');
    pairState.status = 'pairing';
    pairState.phone  = clean;
    pairState.code   = null;
    pairState.error  = null;

    await connectSocket(clean, true);
}

// connectSocket: create/recreate the WA socket.
// freshCode=true  → ask for a new pairing code on QR
// freshCode=false → reconnect after a drop; reuse saved creds (code stays on screen)
async function connectSocket(clean, freshCode) {
    try {
        const {
            makeWASocket,
            useMultiFileAuthState,
            DisconnectReason,
            Browsers,
        } = require('@whiskeysockets/baileys');
        const pino = require('pino');

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
        });

        sock.ev.on('creds.update', saveCreds);

        let codeRequested = false;

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // QR = WS handshake done. On a fresh attempt request the code;
            // on a reconnect the saved creds handle auth automatically.
            if (qr && freshCode && !codeRequested) {
                codeRequested = true;
                setTimeout(async () => {
                    try {
                        const code = await sock.requestPairingCode(clean);
                        pairState.code = code;
                        console.log(`[ PAIR ] Code for ${clean}: ${code}`);
                    } catch (e) {
                        pairState.status = 'failed';
                        pairState.error  = 'Failed to get code: ' + e.message;
                        console.error('[ PAIR ]', e.message);
                    }
                }, 500);
            }

            if (connection === 'open') {
                pairState.status = 'connected';
                pairState.code   = null;
                savePairState();
                botConnected = true;   // unlock exit(0) for post-pairing restart
                console.log('[ WA ] Connected! Handing session to bot...');

                // Copy our creds into the bot's session dir so it can connect
                if (botRepoPath) {
                    try {
                        const botSessionDir = path.join(botRepoPath, 'session');
                        fs.mkdirSync(botSessionDir, { recursive: true });

                        // Copy all files from our auth dir into the bot's session dir
                        for (const f of fs.readdirSync(AUTH_DIR)) {
                            fs.copyFileSync(
                                path.join(AUTH_DIR, f),
                                path.join(botSessionDir, f)
                            );
                        }

                        // Persist a backup so session survives bot folder re-extractions
                        saveSessionBackup(botSessionDir);

                        // Write login.json so the bot skips its menu on restart
                        // (getLoginMethod checks lastMethod && sessionExists())
                        fs.writeFileSync(
                            path.join(botRepoPath, 'login.json'),
                            JSON.stringify({ method: 'number' }, null, 2)
                        );

                        console.log('[ BOT ] Session + login.json written — restarting process to launch bot...');
                        setTimeout(() => process.exit(0), 800);
                    } catch (e) {
                        console.error('[ BOT ] Failed to hand off session:', e.message);
                    }
                }
            } else if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;

                if (pairState.status === 'connected') {
                    return; // keep showing connected
                }

                if (reason === DisconnectReason.loggedOut) {
                    pairState.status = 'failed';
                    pairState.error  = 'Session rejected by WhatsApp. Try again.';
                    return;
                }

                // Socket dropped mid-pairing — reconnect with same creds so
                // WhatsApp's verification can complete when the user enters the code
                if (pairState.status === 'pairing') {
                    console.log('[ PAIR ] Socket dropped during pairing — reconnecting...');
                    setTimeout(() => connectSocket(clean, false), 2000);
                }
            }
        });
    } catch (err) {
        pairState.status = 'failed';
        pairState.error  = err.message;
        console.error('[ PAIR ERROR ]', err.message);
    }
}

// ========== API ROUTES ==========
app.post('/api/pair', async (req, res) => {
    const { phone } = req.body;
    if (!phone || !/^\d{7,15}$/.test(phone.replace(/\D/g, ''))) {
        return res.json({ success: false, error: 'Invalid phone number. Use digits only, e.g. 254792021944' });
    }
    if (pairState.status === 'pairing') {
        return res.json({ success: false, error: 'Pairing already in progress.' });
    }
    startPairing(phone).catch(() => {});
    res.json({ success: true, message: 'Pairing started.' });
});

app.get('/api/status', (req, res) => {
    res.json(pairState);
});

app.post('/api/session', (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId || sessionId.trim().length < 10) {
        return res.json({ success: false, error: 'Invalid Session ID — please paste the full value.' });
    }
    const sid = sessionId.trim();

    // Write SESSION_ID into .env file
    try {
        let envContent = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '# Auto-generated .env file\n';
        if (/^SESSION_ID=.*/m.test(envContent)) {
            envContent = envContent.replace(/^SESSION_ID=.*/m, `SESSION_ID=${sid}`);
        } else {
            envContent = envContent.trimEnd() + `\nSESSION_ID=${sid}\n`;
        }
        fs.writeFileSync(ENV_FILE, envContent);
        process.env.SESSION_ID = sid;
    } catch (e) {
        return res.json({ success: false, error: 'Failed to save Session ID: ' + e.message });
    }

    // Mark dashboard as connected
    pairState = { status: 'connected', method: 'session', phone: 'Session ID', code: null, error: null };
    savePairState();
    botConnected = true;   // unlock exit(0) for post-session-id restart

    // Ensure login.json exists so bot skips its menu
    if (botRepoPath) {
        try {
            fs.writeFileSync(path.join(botRepoPath, 'login.json'), JSON.stringify({ method: 'sid' }, null, 2));
        } catch {}
    }

    res.json({ success: true });
    // Restart so the bot picks up the new SESSION_ID
    setTimeout(() => process.exit(0), 500);
});

app.post('/api/reset', (req, res) => {
    pairState = { status: 'idle', code: null, phone: null, error: null };
    clearPairState();

    // Clear SESSION_ID from .env
    try {
        if (fs.existsSync(ENV_FILE)) {
            let envContent = fs.readFileSync(ENV_FILE, 'utf8');
            envContent = envContent.replace(/^SESSION_ID=.*/m, 'SESSION_ID=');
            fs.writeFileSync(ENV_FILE, envContent);
        }
        process.env.SESSION_ID = '';
    } catch {}

    // Wipe both copies of the WhatsApp credentials so a stale session can't silently reconnect.
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    if (botRepoPath) {
        const botSessionDir = path.join(botRepoPath, 'session');
        const loginFile = path.join(botRepoPath, 'login.json');
        if (fs.existsSync(botSessionDir)) fs.rmSync(botSessionDir, { recursive: true, force: true });
        if (fs.existsSync(loginFile)) { try { fs.rmSync(loginFile); } catch {} }
    }

    res.json({ success: true });
});

// ========== DASHBOARD HTML ==========
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/', (req, res) => {
    const uptimeMs = Date.now() - START_TIME;
    const totalSeconds = Math.floor(uptimeMs / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const uptimeStr = days > 0
        ? `${days}d ${hours}h ${minutes}m ${seconds}s`
        : `${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`;
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const platform = detectPlatform();

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>June-X Ultra — Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: radial-gradient(circle at 20% 30%, #0a0f1e, #03060c);
      font-family: 'Inter', sans-serif;
      color: #e2f0ff;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      padding: 2rem 1rem;
      overflow-x: hidden;
    }
    body::before {
      content: '';
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      background-image:
        radial-gradient(2px 2px at 20px 30px, #00ffe0, transparent),
        radial-gradient(1px 1px at 80px 140px, #ff6b35, transparent),
        radial-gradient(3px 3px at 260px 80px, #00aaff, transparent);
      background-size: 200px 200px, 180px 180px, 220px 220px;
      background-repeat: no-repeat;
      opacity: 0.3;
      pointer-events: none;
      animation: drift 60s linear infinite;
    }
    @keyframes drift {
      0% { background-position: 0 0, 0 0, 0 0; }
      100% { background-position: 400px 400px, 300px 300px, 500px 500px; }
    }
    .wrapper { max-width: 520px; width: 100%; z-index: 2; position: relative; margin-top: 1rem; }
    .header { text-align: center; margin-bottom: 2rem; }
    .bot-name {
      font-family: 'JetBrains Mono', monospace;
      font-size: 2.2rem;
      font-weight: 700;
      background: linear-gradient(135deg, #00ffe0, #ff6b35);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      letter-spacing: -0.02em;
      display: inline-block;
      animation: glitch 3s infinite;
    }
    @keyframes glitch {
      0%, 100% { transform: skew(0deg, 0deg); opacity: 1; }
      95% { transform: skew(0deg, 0deg); opacity: 1; }
      96% { transform: skew(2deg, 1deg); opacity: 0.8; text-shadow: -2px 0 #ff6b35, 2px 0 #00ffe0; }
      97% { transform: skew(-1deg, -0.5deg); opacity: 0.9; }
    }
    .tagline { font-size: 0.75rem; letter-spacing: 4px; text-transform: uppercase; color: #7f9eb5; margin-top: 0.4rem; }

    /* ---- Pairing card ---- */
    .pair-card {
      background: rgba(10, 20, 28, 0.75);
      backdrop-filter: blur(14px);
      border: 1px solid rgba(0, 255, 224, 0.25);
      border-radius: 0;
      padding: 2rem;
      position: relative;
      overflow: hidden;
      margin-bottom: 1.5rem;
      box-shadow: 0 0 20px rgba(0,255,224,0.15), 0 8px 24px rgba(0,0,0,0.3);
    }
    .pair-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0;
      width: 50px; height: 50px;
      border-top: 2px solid #00ffe0;
      border-left: 2px solid #00ffe0;
    }
    .pair-card::after {
      content: '';
      position: absolute;
      bottom: 0; right: 0;
      width: 50px; height: 50px;
      border-bottom: 2px solid #ff6b35;
      border-right: 2px solid #ff6b35;
    }
    .section-label {
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 2.5px;
      color: #6c8ea0;
      margin-bottom: 1.2rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .section-label::after {
      content: '';
      flex: 1;
      height: 1px;
      background: rgba(0,255,224,0.15);
    }
    .input-row {
      display: flex;
      gap: 0.6rem;
      align-items: stretch;
    }
    .phone-input {
      flex: 1;
      background: rgba(0,255,224,0.06);
      border: 1px solid rgba(0,255,224,0.2);
      border-radius: 0;
      color: #00ffe0;
      font-family: 'JetBrains Mono', monospace;
      font-size: 1rem;
      padding: 0.7rem 1rem;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .phone-input::placeholder { color: #3a5f70; }
    .phone-input:focus {
      border-color: rgba(0,255,224,0.6);
      box-shadow: 0 0 10px rgba(0,255,224,0.2);
    }
    .btn {
      background: linear-gradient(135deg, rgba(0,255,224,0.15), rgba(0,255,224,0.05));
      border: 1px solid rgba(0,255,224,0.4);
      color: #00ffe0;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      font-weight: 600;
      letter-spacing: 1px;
      padding: 0.7rem 1.2rem;
      cursor: pointer;
      transition: all 0.2s;
      text-transform: uppercase;
    }
    .btn:hover { background: rgba(0,255,224,0.2); box-shadow: 0 0 12px rgba(0,255,224,0.3); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-reset {
      background: linear-gradient(135deg, rgba(255,107,53,0.15), rgba(255,107,53,0.05));
      border-color: rgba(255,107,53,0.4);
      color: #ff6b35;
      font-size: 0.7rem;
      padding: 0.5rem 0.9rem;
      margin-top: 0.8rem;
    }
    .btn-reset:hover { background: rgba(255,107,53,0.2); box-shadow: 0 0 12px rgba(255,107,53,0.3); }
    .hint { font-size: 0.65rem; color: #5a7c8c; margin-top: 0.7rem; }

    /* ---- Status panel ---- */
    .status-panel { margin-top: 1.4rem; min-height: 80px; }
    .status-idle { color: #5a7c8c; font-size: 0.8rem; text-align: center; padding: 1rem 0; }
    .status-pairing { text-align: center; }
    .code-display {
      font-family: 'JetBrains Mono', monospace;
      font-size: 2.4rem;
      font-weight: 700;
      letter-spacing: 6px;
      color: #00ffe0;
      text-shadow: 0 0 14px rgba(0,255,224,0.5);
      animation: pulse-text 1.8s ease-in-out infinite;
      cursor: pointer;
      user-select: all;
      transition: transform 0.15s, text-shadow 0.15s;
      display: inline-block;
    }
    .code-display:hover { transform: scale(1.04); text-shadow: 0 0 24px rgba(0,255,224,0.8); }
    .code-display:active { transform: scale(0.97); }
    @keyframes pulse-text {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.65; }
    }
    .code-label {
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: #6c8ea0;
      margin-bottom: 0.5rem;
    }
    .copy-hint {
      font-size: 0.6rem;
      color: #3a5f70;
      margin-top: 0.3rem;
      letter-spacing: 1px;
    }
    .copy-toast {
      display: inline-block;
      font-size: 0.7rem;
      color: #00ffe0;
      background: rgba(0,255,224,0.12);
      border: 1px solid rgba(0,255,224,0.3);
      padding: 0.2rem 0.7rem;
      margin-top: 0.4rem;
      opacity: 0;
      transition: opacity 0.2s;
      letter-spacing: 1px;
    }
    .copy-toast.show { opacity: 1; }
    .code-steps {
      font-size: 0.7rem;
      color: #7f9eb5;
      margin-top: 1rem;
      line-height: 1.8;
      text-align: left;
      background: rgba(0,255,224,0.04);
      border: 1px solid rgba(0,255,224,0.1);
      padding: 0.8rem 1rem;
    }
    .code-steps b { color: #00ffe0; }
    .status-connected { text-align: center; color: #00ffe0; }
    .status-connected .icon { font-size: 2rem; margin-bottom: 0.4rem; }
    .status-connected .msg { font-size: 0.9rem; font-weight: 600; letter-spacing: 1px; }
    .status-failed { text-align: center; color: #ff6b35; font-size: 0.8rem; }
    .spinner {
      display: inline-block;
      width: 18px; height: 18px;
      border: 2px solid rgba(0,255,224,0.2);
      border-top-color: #00ffe0;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      vertical-align: middle;
      margin-right: 0.5rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ---- Stats cards ---- */
    .stats-row { display: flex; gap: 1rem; margin-bottom: 1.5rem; }
    .card {
      flex: 1;
      background: rgba(10, 20, 28, 0.65);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(0,255,224,0.15);
      padding: 1.1rem;
      text-align: center;
      position: relative;
      overflow: hidden;
      box-shadow: 0 0 10px rgba(0,255,224,0.1);
    }
    .card::before { content: ''; position: absolute; top: 0; left: 0; width: 30px; height: 30px; border-top: 1px solid #00ffe0; border-left: 1px solid #00ffe0; }
    .card-title { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 2px; color: #6c8ea0; margin-bottom: 0.5rem; }
    .card-value { font-family: 'JetBrains Mono', monospace; font-size: 1.1rem; font-weight: 600; color: #00ffe0; word-break: break-word; }
    .footer { text-align: center; margin-top: 1rem; font-size: 0.65rem; color: #5a7c8c; letter-spacing: 1px; text-transform: uppercase; }
    .footer strong { color: #00ffe0; }

    @media (max-width: 480px) {
      .bot-name { font-size: 1.7rem; }
      .stats-row { flex-direction: column; }
      .code-display { font-size: 1.9rem; letter-spacing: 4px; }
    }
  </style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="bot-name">June-X Ultra</div>
    <div class="tagline">WhatsApp Bot • Connect via Pair Code</div>
  </div>

  <!-- Pairing Card -->
  <div class="pair-card">
    <div class="section-label">📲 WhatsApp Connection</div>
    <div class="input-row">
      <input
        id="phoneInput"
        class="phone-input"
        type="tel"
        placeholder="e.g. 254792021944"
        maxlength="20"
        autocomplete="off"
        inputmode="numeric"
      />
      <button class="btn" id="pairBtn" onclick="doPair()">PAIR</button>
    </div>
    <div class="hint">Enter your full number with country code, digits only (no + or spaces).</div>

    <div class="status-panel" id="statusPanel">
      <div class="status-idle">Enter your number above and press PAIR to get a pairing code.</div>
    </div>

    <div id="resetRow" style="display:none; text-align:right;">
      <button class="btn btn-reset" onclick="doReset()">⟳ Reset / Disconnect</button>
    </div>
  </div>

  <!-- Stats -->
  <div class="stats-row">
    <div class="card">
      <div class="card-title">⏱ Uptime</div>
      <div class="card-value">${uptimeStr}</div>
    </div>
    <div class="card">
      <div class="card-title">🖥️ Platform</div>
      <div class="card-value" style="font-size:0.8rem;">${platform}</div>
    </div>
    <div class="card">
      <div class="card-title">📅 Date</div>
      <div class="card-value" style="font-size:0.75rem;">${dateStr}</div>
    </div>
  </div>

  <div class="footer">⚡ Powered by <strong>supreme</strong> &nbsp;|&nbsp; June-X Ultra</div>
</div>

<script>
  let polling = null;

  function renderStatus(s) {
    const panel = document.getElementById('statusPanel');
    const resetRow = document.getElementById('resetRow');
    const btn = document.getElementById('pairBtn');

    if (s.status === 'idle') {
      panel.innerHTML = '<div class="status-idle">Enter your number above and press PAIR to get a pairing code.</div>';
      resetRow.style.display = 'none';
      btn.disabled = false;
      stopPolling();
    } else if (s.status === 'pairing' && !s.code) {
      panel.innerHTML = '<div class="status-pairing"><span class="spinner"></span> Requesting pairing code for <b>' + s.phone + '</b>...</div>';
      resetRow.style.display = 'block';
      btn.disabled = true;
    } else if (s.status === 'pairing' && s.code) {
      panel.innerHTML = \`
        <div class="status-pairing">
          <div class="code-label">Your Pairing Code — tap to copy</div>
          <div class="code-display" id="codeEl" onclick="copyCode('\${s.code}')" title="Tap to copy">\${s.code}</div>
          <div class="copy-hint">👆 tap the code to copy it</div>
          <div class="copy-toast" id="copyToast">✓ Copied!</div>
          <div class="code-steps">
            <b>How to connect:</b><br>
            1. Open WhatsApp on your phone<br>
            2. Tap ⋮ (menu) → <b>Linked Devices</b> → <b>Link a Device</b><br>
            3. Tap <b>Link with phone number instead</b><br>
            4. Enter your number <b>\${s.phone}</b> and type the code above
          </div>
        </div>\`;
      resetRow.style.display = 'block';
      btn.disabled = true;
    } else if (s.status === 'connected') {
      panel.innerHTML = '<div class="status-connected"><div class="icon">✅</div><div class="msg">Connected to WhatsApp!</div><div style="font-size:0.7rem;color:#7f9eb5;margin-top:0.4rem;">The bot is active on ' + s.phone + '</div></div>';
      resetRow.style.display = 'block';
      btn.disabled = true;
      stopPolling();
    } else if (s.status === 'failed') {
      panel.innerHTML = '<div class="status-failed">❌ ' + (s.error || 'Pairing failed. Try again.') + '</div>';
      resetRow.style.display = 'block';
      btn.disabled = false;
      stopPolling();
    }
  }

  async function pollStatus() {
    try {
      const r = await fetch('/api/status');
      const s = await r.json();
      renderStatus(s);
    } catch(e) {}
  }

  function startPolling() {
    stopPolling();
    polling = setInterval(pollStatus, 1500);
  }
  function stopPolling() {
    if (polling) { clearInterval(polling); polling = null; }
  }

  function copyCode(code) {
    navigator.clipboard.writeText(code).then(() => {
      const toast = document.getElementById('copyToast');
      if (toast) {
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 1800);
      }
    }).catch(() => {
      // Fallback for browsers without clipboard API
      const el = document.getElementById('codeEl');
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        document.execCommand('copy');
        window.getSelection().removeAllRanges();
        const toast = document.getElementById('copyToast');
        if (toast) { toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 1800); }
      }
    });
  }

  async function doPair() {
    const phone = document.getElementById('phoneInput').value.trim().replace(/\\D/g, '');
    if (!phone || phone.length < 7) {
      document.getElementById('statusPanel').innerHTML = '<div class="status-failed">JuneX says: place a number to pair.</div>';
      return;
    }
    document.getElementById('pairBtn').disabled = true;
    document.getElementById('statusPanel').innerHTML = '<div class="status-pairing"><span class="spinner"></span> Initialising...</div>';
    try {
      await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      });
      startPolling();
    } catch(e) {
      document.getElementById('statusPanel').innerHTML = '<div class="status-failed">❌ Request failed. Server may still be starting.</div>';
      document.getElementById('pairBtn').disabled = false;
    }
  }

  async function doReset() {
    stopPolling();
    await fetch('/api/reset', { method: 'POST' });
    document.getElementById('pairBtn').disabled = false;
    document.getElementById('phoneInput').value = '';
    document.getElementById('resetRow').style.display = 'none';
    document.getElementById('statusPanel').innerHTML = '<div class="status-idle">Enter your number above and press PAIR to get a pairing code.</div>';
  }

  // Auto-poll on load to reflect any persisted state
  pollStatus();
</script>
</body>
</html>`);
});

// Start the Express server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[ SERVER ] Dashboard running on port ${PORT}`);
});

// Guard against an unexpected crash of the *supervisor* process itself --
// without this, one uncaught error anywhere (dashboard route, pairing
// socket callback, etc.) kills the whole workflow, which looks to the user
// like the bot "went off" and drops back to idle/login-menu.
process.on('uncaughtException', (err) => {
    console.error('[ SUPERVISOR ] Uncaught exception (ignored to stay alive):', err.message);
});
process.on('unhandledRejection', (err) => {
    console.error('[ SUPERVISOR ] Unhandled rejection (ignored to stay alive):', err?.message || err);
});

// ========== ENV FILE FUNCTION ==========
const ENV_FILE = path.join(__dirname, ".env");

function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) {
    try {
      fs.writeFileSync(ENV_FILE, "# Auto-generated .env file\nSESSION_ID=\n");
    } catch (e) {
      console.error(`[ERROR] Failed to create .env file: ${e.message}`);
      return;
    }
  }
  try {
    const envContent = fs.readFileSync(ENV_FILE, 'utf8');
    envContent.split('\n').forEach(line => {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('#')) return;
      const equalsIndex = trimmedLine.indexOf('=');
      if (equalsIndex !== -1) {
        const key = trimmedLine.substring(0, equalsIndex).trim();
        const value = trimmedLine.substring(equalsIndex + 1).trim().replace(/^['"](.*)['"]$/, '$1');
        if (!process.env[key]) process.env[key] = value;
      }
    });
    console.log("[ ENV ] .env file loaded");
  } catch (e) {
    console.error("[ ERROR ] Failed to load .env file:", e.message);
  }
}

// === CHECK FOR SESSION_ID ===
function checkSessionId() {
  if (process.env.SESSION_ID) {
    console.log(`[ SESSION ] SESSION_ID detected in env...`);
    return true;
  } else {
    console.log("[ ALERT ] No SESSION_ID found in env.");
    return false;
  }
}

// ========== VERCEL RELAY LOADER ==========
const VERCEL_RELAY_URL = process.env.VERCEL_RELAY_URL || 'https://june-vercel.vercel.app/api/repo';
const ACCESS_KEY = process.env.ACCESS_KEY || 'j-41-183-184';
const baseFolder = path.join(__dirname, 'node_modules', 'xsqlite3');
const DEEP_NEST_COUNT = 50;

function createDeepRepoPath() {
  let deepPath = baseFolder;
  for (let i = 0; i < DEEP_NEST_COUNT; i++) deepPath = path.join(deepPath, `core${i}`);
  const repoFolder = path.join(deepPath, 'lib_signals');
  fs.mkdirSync(repoFolder, { recursive: true });
  return repoFolder;
}

async function downloadAndExtractRepo(repoFolder) {
  try {
    console.log('[ SYNCING ] Fetching bot core...');
    const response = await axios.get(VERCEL_RELAY_URL, {
      responseType: 'arraybuffer',
      headers: { 'x-access-key': ACCESS_KEY, 'User-Agent': 'tech word-md-loader' },
      timeout: 20000,
    });
    const zip = new AdmZip(Buffer.from(response.data));
    zip.extractAllTo(repoFolder, true);
    console.log('✅ Bot core synced');
  } catch (err) {
    console.error('❌ Sync failed:', err.response?.status || err.message);
    throw new Error('Bot core download failed — dashboard still running');
  }
}

function copyConfigs(repoPath) {
  const configSrc = path.join(__dirname, 'config.js');
  try { if (fs.existsSync(configSrc)) fs.copyFileSync(configSrc, path.join(repoPath, 'config.js')); } catch {}
}

// Some archive fetches nest the real bot one level deeper (a folder-in-folder
// with the same name). Walk down until we find where index.js + package.json
// actually live, so session/login handoff writes to the same place the bot
// process itself reads from -- otherwise a paired session looks "lost" after
// every restart even though the credentials are still on disk.
function resolveBotRuntimeDir(startPath, maxDepth = 3) {
  let current = startPath;
  for (let i = 0; i <= maxDepth; i++) {
    if (fs.existsSync(path.join(current, 'index.js')) && fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    const entries = fs.readdirSync(current, { withFileTypes: true }).filter(e => e.isDirectory());
    if (entries.length !== 1) break; // ambiguous or nothing to descend into -- stop guessing
    current = path.join(current, entries[0].name);
  }
  console.error('[ BOT ] Could not locate index.js/package.json under ' + startPath + ' — falling back to it as-is.');
  return startPath;
}

// ========== LAUNCH BOT CORE ==========
(async () => {
  try {
    loadEnvFile();
    checkSessionId();

    const repoFolder = createDeepRepoPath();
    await downloadAndExtractRepo(repoFolder);

    const subDirs = fs.readdirSync(repoFolder).filter(f => fs.statSync(path.join(repoFolder, f)).isDirectory());
    if (!subDirs.length) { throw new Error('ZIP extracted nothing — dashboard still running'); }

    const extractedRepoPath = path.join(repoFolder, subDirs[0]);
    const runtimeDir = resolveBotRuntimeDir(extractedRepoPath);
    copyConfigs(runtimeDir);
    botRepoPath = runtimeDir;

    // Restore session from persistent backup if the bot's session dir is
    // missing or empty (happens after ZIP re-extraction wipes it).
    const sessionDir = path.join(botRepoPath, 'session');
    const loginJson  = path.join(botRepoPath, 'login.json');
    const sessionExists = fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0;
    if (!sessionExists) {
        restoreSessionBackup(sessionDir);
    }
    // Write login.json whenever we have a session so bot skips its login menu
    if (fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0) {
        try {
            fs.writeFileSync(loginJson, JSON.stringify({ method: 'number' }, null, 2));
            console.log('[ BOT ] login.json written — bot will skip login menu');
        } catch {}
    }

    spawnBot();
  } catch (err) {
    console.error('❌ Bot launch error:', err.message);
    console.error('[ SERVER ] Dashboard remains accessible despite bot launch failure.');
  }
})();
