// Core modules only at the top — these never fail to resolve, so the
// dashboard can always come up even if something else on the platform
// (native builds, optional deps, etc.) is broken.
const fs = require('fs');
const path = require('path');
const express = require('express');
const os = require('os');
const { spawn } = require('child_process');

// dotenv, axios and adm-zip are only needed for the background bot-core
// download, not for the dashboard itself. Some hosting platforms (Heroku,
// certain panels) fail to install every optional/native dependency, and a
// missing module here used to throw synchronously and crash the whole
// process before Express ever got a chance to bind to the port — which is
// why the dashboard would sometimes never show up. Load them defensively so
// a problem with any one of them degrades gracefully instead of taking the
// whole dashboard down.
function safeRequire(name) {
    try {
        return require(name);
    } catch (e) {
        console.error(`[ STARTUP ] Optional module "${name}" unavailable: ${e.message}`);
        return null;
    }
}

const dotenv = safeRequire('dotenv');
if (dotenv) {
    try { dotenv.config(); } catch (e) { console.error('[ STARTUP ] dotenv.config() failed:', e.message); }
}
const axios = safeRequire('axios');
const AdmZip = safeRequire('adm-zip');
const pg = safeRequire('pg');

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

// ========== DATABASE-BACKED SESSION PERSISTENCE ==========
// Local files (.session_backup, auth_info_pair, the bot's own session/ dir)
// all live on the same disk, which platforms like Heroku wipe on every dyno
// restart/redeploy. A real external database survives that wipe, so when
// DATABASE_URL is present we mirror the session there too — no manual
// copy/paste of a session string required. Falls back to local-file-only
// behavior automatically when no database is configured.
let dbPool = null;
let dbReady = false;

function getDb() {
    if (dbPool) return dbPool;
    if (!pg || !process.env.DATABASE_URL) return null;
    try {
        const noSsl = /sslmode=disable/i.test(process.env.DATABASE_URL);
        dbPool = new pg.Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: noSsl ? false : { rejectUnauthorized: false },
        });
        dbPool.on('error', (e) => console.error('[ DB ] Pool error:', e.message));
    } catch (e) {
        console.error('[ DB ] Failed to create pool:', e.message);
        dbPool = null;
    }
    return dbPool;
}

async function ensureSessionTable() {
    const db = getDb();
    if (!db) return false;
    if (dbReady) return true;
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS whatsapp_sessions (
                id INT PRIMARY KEY,
                files JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
        dbReady = true;
        return true;
    } catch (e) {
        console.error('[ DB ] Failed to prepare session table:', e.message);
        return false;
    }
}

// Save every file in srcDir into a single DB row keyed by filename, so a
// restart on a wiped filesystem can fully reconstruct the session directory.
async function saveSessionToDb(srcDir) {
    const db = getDb();
    if (!db || !(await ensureSessionTable())) return false;
    try {
        const files = {};
        for (const f of fs.readdirSync(srcDir)) {
            files[f] = fs.readFileSync(path.join(srcDir, f)).toString('base64');
        }
        await db.query(
            `INSERT INTO whatsapp_sessions (id, files, updated_at) VALUES (1, $1, now())
             ON CONFLICT (id) DO UPDATE SET files = EXCLUDED.files, updated_at = now()`,
            [JSON.stringify(files)]
        );
        console.log('[ DB ] Session saved to database.');
        return true;
    } catch (e) {
        console.error('[ DB ] Session save failed:', e.message);
        return false;
    }
}

async function restoreSessionFromDb(destDir) {
    const db = getDb();
    if (!db || !(await ensureSessionTable())) return false;
    try {
        const { rows } = await db.query('SELECT files FROM whatsapp_sessions WHERE id = 1');
        if (!rows.length) return false;
        const files = rows[0].files;
        const names = Object.keys(files);
        if (!names.length) return false;
        fs.mkdirSync(destDir, { recursive: true });
        for (const name of names) {
            fs.writeFileSync(path.join(destDir, name), Buffer.from(files[name], 'base64'));
        }
        console.log('[ DB ] Session restored from database.');
        return true;
    } catch (e) {
        console.error('[ DB ] Session restore failed:', e.message);
        return false;
    }
}

async function clearSessionFromDb() {
    const db = getDb();
    if (!db || !(await ensureSessionTable())) return;
    try {
        await db.query('DELETE FROM whatsapp_sessions WHERE id = 1');
        console.log('[ DB ] Session cleared from database.');
    } catch (e) {
        console.error('[ DB ] Session clear failed:', e.message);
    }
}

async function saveSessionBackup(srcDir) {
    try {
        fs.mkdirSync(SESSION_BACKUP_DIR, { recursive: true });
        for (const f of fs.readdirSync(srcDir)) {
            fs.copyFileSync(path.join(srcDir, f), path.join(SESSION_BACKUP_DIR, f));
        }
        console.log('[ SESSION ] Backup saved to .session_backup/');
    } catch (e) {
        console.error('[ SESSION ] Backup failed:', e.message);
    }
    // Best-effort — local backup above already succeeded/failed independently.
    await saveSessionToDb(srcDir);
}

async function restoreSessionBackup(destDir) {
    let localHasFiles = fs.existsSync(SESSION_BACKUP_DIR) && fs.readdirSync(SESSION_BACKUP_DIR).length > 0;

    // Local backup missing (e.g. wiped by a Heroku dyno restart) — try to
    // rehydrate it from the database before doing the local copy below.
    if (!localHasFiles) {
        const restored = await restoreSessionFromDb(SESSION_BACKUP_DIR);
        localHasFiles = restored && fs.readdirSync(SESSION_BACKUP_DIR).length > 0;
    }

    if (!localHasFiles) return false;
    try {
        fs.mkdirSync(destDir, { recursive: true });
        for (const f of fs.readdirSync(SESSION_BACKUP_DIR)) {
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

// ========== BOT CHILD PROCESS ==========
// The bot runs as a completely separate child process so it can never kill,
// hang, or steal the port of our Express dashboard — no matter what it does.
let botProcess = null;

function killBot() {
    if (botProcess) {
        try { botProcess.kill('SIGTERM'); } catch {}
        botProcess = null;
    }
}

async function spawnBot(attempt = 1) {
    if (!botRepoPath) return;
    const MAX_ATTEMPTS = 5;

    // Only restore from backup if the bot's session dir is actually missing/empty
    // (it cleared its own session, or the whole filesystem was wiped by a platform
    // restart — restoreSessionBackup falls back to the database in that case).
    //
    // Previously this restored unconditionally on every spawn, which meant a plain
    // in-process restart (e.g. the .restart/.update command, or any ordinary crash)
    // would blow away the bot's current, perfectly valid session with the stale
    // snapshot taken back at initial pairing — forcing a re-pair even though nothing
    // on disk was actually lost. If the session is still there, just refresh the
    // backup from it so it stays current for the case that DOES need it later.
    const sessionDir = path.join(botRepoPath, 'session');
    const liveSessionExists = fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0;

    if (liveSessionExists) {
        try {
            await saveSessionBackup(sessionDir);
        } catch (e) {
            console.error('[ BOT ] Failed to refresh session backup:', e.message);
        }
    } else {
        await restoreSessionBackup(sessionDir);
    }

    // Write login.json so the bot skips its interactive menu when a session exists
    if (fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0) {
        try {
            fs.writeFileSync(
                path.join(botRepoPath, 'login.json'),
                JSON.stringify({ method: 'number' }, null, 2)
            );
        } catch {}
    }

    // Build a clean env for the child: everything from parent EXCEPT PORT so
    // the bot's own HTTP server (if any) doesn't steal our dashboard port.
    const botEnv = Object.assign({}, process.env);
    delete botEnv.PORT;

    console.log(`[ BOT ] Spawning child process (attempt ${attempt}/${MAX_ATTEMPTS})...`);

    botProcess = spawn(process.execPath, ['index.js'], {
        cwd:   botRepoPath,
        env:   botEnv,
        stdio: ['ignore', 'pipe', 'pipe'],   // ignore stdin — no readline blocking
    });

    botProcess.stdout.on('data', (d) => process.stdout.write(d));
    botProcess.stderr.on('data', (d) => process.stderr.write(d));

    botProcess.on('error', (err) => {
        console.error('[ BOT ] Spawn error:', err.message);
        botProcess = null;
    });

    botProcess.on('exit', (code, signal) => {
        console.log(`[ BOT ] Child exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`);
        botProcess = null;

        const hasBackup = fs.existsSync(SESSION_BACKUP_DIR) &&
            fs.readdirSync(SESSION_BACKUP_DIR).length > 0;

        if (code === 0 && hasBackup) {
            // Clean exit with a saved session — bot chose to restart (normal cycle)
            console.log('[ BOT ] Restarting with saved session...');
            setTimeout(() => spawnBot(1), 2000);
        } else if (code !== 0 && code !== null && attempt < MAX_ATTEMPTS) {
            const delay = attempt * 3000;
            console.log(`[ BOT ] Crashed — retrying in ${delay / 1000}s...`);
            setTimeout(() => spawnBot(attempt + 1), delay);
        } else {
            console.log('[ BOT ] Stopped. Dashboard is accessible for pairing.');
        }
    });
}

// ========== BAILEYS PAIRING ==========
const AUTH_DIR = path.resolve(__dirname, 'auth_info_pair');
loadPairState(); // restore "connected" state (and logout option) across restarts

// Build a portable SESSION_ID string from the paired creds. Platforms like
// Heroku wipe the local filesystem on every dyno restart/redeploy, so any
// session that only lives in local files (.session_backup, auth_info_pair,
// the bot's own session dir) is lost and pairing is requested again. A
// SESSION_ID stored as a real platform Config Var/secret survives that wipe
// — the downloaded bot core already knows how to bootstrap from it on boot.
function generateSessionId() {
    try {
        const credsPath = path.join(AUTH_DIR, 'creds.json');
        if (!fs.existsSync(credsPath)) return null;
        const encoded = Buffer.from(fs.readFileSync(credsPath)).toString('base64');
        return `Ultra-X:~${encoded}`;
    } catch (e) {
        console.error('[ SESSION ] Failed to generate SESSION_ID:', e.message);
        return null;
    }
}

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
                pairState.sessionId = generateSessionId();
                savePairState();
                botConnected = true;   // unlock exit(0) for post-pairing restart
                console.log('[ WA ] Connected! Handing session to bot...');

                // Persist immediately from our own auth dir (local + database), completely
                // independent of whether the bot-core zip has finished downloading yet.
                // Previously this only ran inside the `if (botRepoPath)` block below, so if
                // pairing finished before the background download did, the session was never
                // saved anywhere — the exact race that made restarts "still clear" the session
                // even with a database configured.
                try {
                    await saveSessionBackup(AUTH_DIR);
                } catch (e) {
                    console.error('[ SESSION ] Immediate persist failed:', e.message);
                }

                // Copy our creds into the bot's session dir so the already-downloaded
                // child process can connect right away. If the download isn't done yet,
                // that's fine — spawnBot() restores from the backup we just wrote above
                // once the download finishes further down in the boot sequence.
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

                        // Write login.json so the bot skips its menu on restart
                        // (getLoginMethod checks lastMethod && sessionExists())
                        fs.writeFileSync(
                            path.join(botRepoPath, 'login.json'),
                            JSON.stringify({ method: 'number' }, null, 2)
                        );

                        console.log('[ BOT ] Session + login.json written — restarting bot child process...');
                        killBot();
                        setTimeout(() => spawnBot(1), 1000);
                    } catch (e) {
                        console.error('[ BOT ] Failed to hand off session:', e.message);
                    }
                } else {
                    console.log('[ BOT ] Bot core not downloaded yet — session already saved; it will be picked up automatically once the download finishes.');
                }

                // Critical: close OUR OWN socket now that the session has been handed
                // off. Leaving it open means two processes (this supervisor and the
                // spawned bot child) hold a live WhatsApp connection on the exact same
                // session/identity at once. WhatsApp treats that as a stream conflict —
                // over time that reliably escalates into a 401 (logged out) or 500 (bad
                // session) close event, and the bot's own code wipes its session folder
                // in response. That looked identical to "the session got cleared" even
                // with zero platform restarts involved. sock.end() just drops our local
                // websocket — it does NOT call WhatsApp's logout endpoint, so the session
                // itself stays valid for the child process to use.
                try {
                    sock.end(undefined);
                    console.log('[ WA ] Supervisor socket closed — bot child now owns the connection exclusively.');
                } catch (e) {
                    console.error('[ WA ] Failed to close supervisor socket:', e.message);
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
    res.json({ ...pairState, dbConfigured: !!getDb() });
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
    pairState = { status: 'connected', method: 'session', phone: 'Session ID', code: null, error: null, sessionId: sid };
    savePairState();

    res.json({ success: true });
    // Kill existing bot child and relaunch so it picks up the new SESSION_ID
    killBot();
    setTimeout(() => spawnBot(1), 1000);
});

app.post('/api/reset', async (req, res) => {
    pairState = { status: 'idle', code: null, phone: null, error: null };
    clearPairState();
    await clearSessionFromDb();

    // Clear SESSION_ID from .env
    try {
        if (fs.existsSync(ENV_FILE)) {
            let envContent = fs.readFileSync(ENV_FILE, 'utf8');
            envContent = envContent.replace(/^SESSION_ID=.*/m, 'SESSION_ID=');
            fs.writeFileSync(ENV_FILE, envContent);
        }
        process.env.SESSION_ID = '';
    } catch {}

    // Wipe every copy of the WhatsApp credentials so a stale session can't silently
    // reconnect — including the persistent backup, otherwise spawnBot() would just
    // restore the old session again on its next restore-before-spawn pass.
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    if (fs.existsSync(SESSION_BACKUP_DIR)) fs.rmSync(SESSION_BACKUP_DIR, { recursive: true, force: true });
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
      let sessionBlock;
      if (s.dbConfigured) {
        sessionBlock = \`
          <div class="code-steps" style="text-align:left;">
            <b>✅ Session auto-saved to the database.</b><br>
            No copy/paste needed — if the bot restarts or the host wipes local files
            (e.g. a Heroku dyno restart), it automatically reconnects using the session
            stored in the database instead of asking you to pair again.
          </div>\`;
      } else if (s.sessionId) {
        sessionBlock = \`
          <div class="code-steps" style="text-align:left;">
            <b>⚠️ Keep this session alive across restarts:</b><br>
            No database is configured, and hosts like Heroku wipe local files on every dyno
            restart/redeploy, so without this you'll be asked to pair again. Copy the Session ID
            below and set it as a <b>SESSION_ID</b> Config Var / environment variable on your host.
            <div class="code-label" style="margin-top:0.8rem;">Session ID — tap to copy</div>
            <div id="sessionIdEl" onclick="copySessionId()" title="Tap to copy"
                 style="font-family:'JetBrains Mono',monospace; font-size:0.65rem; word-break:break-all;
                        color:#00ffe0; background:rgba(0,255,224,0.06); border:1px solid rgba(0,255,224,0.2);
                        padding:0.6rem; cursor:pointer; user-select:all;">\${s.sessionId}</div>
            <div class="copy-hint">👆 tap to copy</div>
            <div class="copy-toast" id="sessionCopyToast">✓ Copied!</div>
          </div>\`;
      } else {
        sessionBlock = '';
      }
      panel.innerHTML = '<div class="status-connected"><div class="icon">✅</div><div class="msg">Connected to WhatsApp!</div><div style="font-size:0.7rem;color:#7f9eb5;margin-top:0.4rem;">The bot is active on ' + s.phone + '</div></div>' + sessionBlock;
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

  function copySessionId() {
    const el = document.getElementById('sessionIdEl');
    if (!el) return;
    const text = el.textContent;
    navigator.clipboard.writeText(text).then(() => {
      const toast = document.getElementById('sessionCopyToast');
      if (toast) { toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 1800); }
    }).catch(() => {
      const range = document.createRange();
      range.selectNodeContents(el);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      document.execCommand('copy');
      window.getSelection().removeAllRanges();
      const toast = document.getElementById('sessionCopyToast');
      if (toast) { toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 1800); }
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
  if (!axios || !AdmZip) {
    throw new Error('axios/adm-zip not installed — skipping bot core download, dashboard still running');
  }
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
        await restoreSessionBackup(sessionDir);
    }
    // Write login.json whenever we have a session so bot skips its login menu
    const sessionAvailable = fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0;
    if (sessionAvailable) {
        try {
            fs.writeFileSync(loginJson, JSON.stringify({ method: 'number' }, null, 2));
            console.log('[ BOT ] login.json written — bot will skip login menu');
        } catch {}

        // pair_state.json is a local file too, so a platform restart that wipes
        // disk also wipes our own "connected" flag even though the session
        // itself just got rehydrated (from local backup or the database) above.
        // Reflect that on the dashboard instead of showing the pairing form again.
        if (pairState.status !== 'connected') {
            pairState = { status: 'connected', code: null, phone: pairState.phone || 'Restored session', error: null };
            savePairState();
        }
    }

    spawnBot();
  } catch (err) {
    console.error('❌ Bot launch error:', err.message);
    console.error('[ SERVER ] Dashboard remains accessible despite bot launch failure.');
  }
})();
