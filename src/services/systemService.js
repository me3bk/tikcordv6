// services/systemService.js - system maintenance helpers
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const logger = require('../utils/logger');
const videoDownloader = require('./videoDownloader');

const execAsync = promisify(exec);
const MAX_OUTPUT = 1800;

function trimOutput(text = '') {
  const clean = text.trim() || '(no output)';
  if (clean.length <= MAX_OUTPUT) return clean;
  return `${clean.slice(0, MAX_OUTPUT - 3)}...`;
}

async function runShell(command, { timeout = 10 * 60 * 1000, maxBuffer = 20 * 1024 * 1024 } = {}) {
  try {
    const { stdout, stderr } = await execAsync(command, { timeout, maxBuffer });
    return trimOutput(`${stdout}${stderr}`);
  } catch (error) {
    error.output = trimOutput(`${error.stdout || ''}${error.stderr || ''}`);
    throw error;
  }
}

async function getDiskUsage() {
  try {
    const { stdout } = await execAsync("df -h / | tail -1", { timeout: 5000 });
    const parts = stdout.trim().split(/\s+/);
    return {
      size: parts[1],
      used: parts[2],
      avail: parts[3],
      percent: parts[4]
    };
  } catch (error) {
    logger.warn('Disk usage lookup failed:', { error: error.message });
    return null;
  }
}

async function getSystemStatus() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  
  return {
    load1: os.loadavg()[0] || 0,
    cpuCount: os.cpus()?.length || 1,
    uptime: os.uptime(),
    memTotal: totalMem,
    memUsed: usedMem,
    memPercent: totalMem ? (usedMem / totalMem) * 100 : 0,
    disk: await getDiskUsage()
  };
}

async function runAptUpgrade() {
  return await runShell('sudo apt update && sudo apt upgrade -y', {
    timeout: 15 * 60 * 1000,
    maxBuffer: 25 * 1024 * 1024
  });
}

async function updateYtDlpBinary() {
  const updated = await videoDownloader.updateYtDlp();
  return updated
    ? 'yt-dlp updated successfully.'
    : 'yt-dlp is already up to date or no update was needed.';
}

function scheduleReboot(delayMs = 5000) {
  setTimeout(() => {
    exec('sudo reboot', (error) => {
      if (error) {
        logger.error('Failed to execute reboot command:', { error: error.message });
      }
    });
  }, delayMs);
}

module.exports = {
  getSystemStatus,
  runAptUpgrade,
  updateYtDlpBinary,
  scheduleReboot,
  trimOutput
};
