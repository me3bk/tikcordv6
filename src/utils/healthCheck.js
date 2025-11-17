// utils/healthCheck.js - Basic smoke test for TikCord
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const { CONFIG, validateConfig } = require('../config');
const videoDownloader = require('../services/videoDownloader');
const persistenceService = require('../services/persistenceService');

function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 16) {
    throw new Error(`Node.js version too low: ${process.versions.node} (need >= 16.0.0)`);
  }
}

async function ensureTempDirWritable() {
  const tempFile = path.join(CONFIG.PATHS.TEMP_DIR, `healthcheck_${Date.now()}.tmp`);
  await videoDownloader.ensureTempDir();
  await fs.promises.writeFile(tempFile, 'ok');
  await fs.promises.unlink(tempFile);
  return true;
}

async function ensurePersistenceOk() {
  if (!persistenceService.isReady()) {
    throw new Error('Persistence service (SQLite) is not ready');
  }

  // Light check to ensure DB is accessible
  persistenceService.getStatsSummary();
  return true;
}

async function run() {
  console.log('TikCord Health Check');
  console.log('====================');

  // Node.js version check
  process.stdout.write('0) Checking Node.js version... ');
  checkNodeVersion();
  console.log('OK');

  // Configuration validation doubles as a regression test for require-time syntax errors
  process.stdout.write('1) Validating configuration... ');
  validateConfig();
  console.log('OK');

  // Token presence
  process.stdout.write('2) Checking Discord token... ');
  if (!CONFIG.DISCORD.TOKEN) {
    throw new Error('Discord TOKEN is missing');
  }
  console.log('OK');

  // yt-dlp availability
  process.stdout.write('3) Checking yt-dlp installation... ');
  const hasYtDlp = await videoDownloader.checkYtDlp();
  if (!hasYtDlp) {
    throw new Error('yt-dlp not available. Install it and ensure it is on PATH.');
  }
  console.log('OK');

  // Temp directory write access
  process.stdout.write('4) Verifying temp directory access... ');
  await ensureTempDirWritable();
  console.log('OK');

  // Persistence (SQLite) check
  process.stdout.write('5) Checking persistence (SQLite)... ');
  await ensurePersistenceOk();
  console.log('OK');

  console.log('\nAll health checks passed.');
}

run().catch((error) => {
  console.error('\nHealth check failed:', error.message);
  process.exit(1);
});
