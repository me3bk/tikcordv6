// config/index.js - Centralized configuration management
// ✅ OPTIMIZED FOR MAXIMUM QUALITY - Private Bot Edition
const path = require('path');

const CONFIG = {
  // Discord Settings
  DISCORD: {
    LIMIT_BYTES: ((parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 8) * 1024 * 1024),
    TOKEN: process.env.TOKEN,
    ADMIN_WEBHOOK_URL: process.env.ADMIN_WEBHOOK_URL,
    ADMIN_USER_IDS: (process.env.ADMIN_USER_IDS || '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean)
  },

  // Download Settings - ✅ ENHANCED FOR MAXIMUM QUALITY
  DOWNLOAD: {
    MAX_CONCURRENT: parseInt(process.env.MAX_CONCURRENT) || 5,
    MAX_RETRIES: parseInt(process.env.MAX_RETRIES) || 7, // ✅ Increased default to 7
    MAX_QUEUE_SIZE: parseInt(process.env.MAX_QUEUE_SIZE) || 50,
    TIMEOUT: 600000, // ✅ 10 minutes (increased from 5)
    INFO_TIMEOUT: 60000, // ✅ 60 seconds (increased from 45)
    MAX_BUFFER_SIZE: 500 * 1024 * 1024, // ✅ 500MB (increased from 150MB)
    STUCK_DETECTION_TIME: 30000 // 30 seconds
  },

  // System Settings
  SYSTEM: {
    DISK_WARNING_THRESHOLD: parseInt(process.env.DISK_WARNING_THRESHOLD) || 90,
    AUTO_UPDATE_DAY: parseInt(process.env.AUTO_UPDATE_DAY) || 0,
    AUTO_UPDATE_HOUR: parseInt(process.env.AUTO_UPDATE_HOUR) || 3,
    MEMORY_LIMIT_MB: 500,
    CLEANUP_INTERVAL: 3600000, // 1 hour
    HEALTH_CHECK_INTERVAL: 3600000 // 1 hour
  },

  // API Keys
  API: {
    RAPIDAPI_KEY: process.env.RAPIDAPI_KEY
  },

  // File Paths
  PATHS: {
    TEMP_DIR: path.join(require('os').tmpdir(), 'tikcord-temp'),
    DATA_DIR: path.join(process.cwd(), 'data'),
    COOKIES: {
      tiktok: path.join(__dirname, '..', 'cookies', 'tiktok_cookies.txt'),
      instagram: path.join(__dirname, '..', 'cookies', 'instagram_cookies.txt')
    }
  },

  // ✅ MAXIMUM QUALITY FORMATS - No restrictions!
  // Gets best available: any codec, any resolution, any framerate
  FORMATS: {
    tiktok: [
      'bestvideo*+bestaudio/best',
      'best'
    ],
    instagram: [
      'bestvideo*+bestaudio/best',
      'best'
    ],
    snapchat: [
      'bestvideo*+bestaudio/best',
      'best'
    ],
    youtube: [
      'bestvideo*+bestaudio/best',
      'best'
    ],
    twitter: [
      'bestvideo*+bestaudio/best',
      'best'
    ],
    facebook: [
      'bestvideo*+bestaudio/best',
      'best'
    ],
    reddit: [
      'bestvideo*+bestaudio/best',
      'best'
    ],
    default: [
      'bestvideo*+bestaudio/best',
      'best'
    ]
  },

  // Impersonation targets for bypassing restrictions
  IMPERSONATE_TARGETS: {
    tiktok: 'Chrome-131:Android-14',
    instagram: 'Chrome-136:Macos-15',
    youtube: 'Chrome-136:Macos-15',
    twitter: 'Chrome-131:Windows-10',
    snapchat: 'Chrome-131:Android-14',
    facebook: 'Chrome-131:Windows-10',
    reddit: 'Chrome-136:Macos-15',
    default: 'Chrome-131:Android-14'
  }
};

// Validate required environment variables
function validateConfig() {
  const required = ['TOKEN'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  
  return true;
}

module.exports = { CONFIG, validateConfig };
