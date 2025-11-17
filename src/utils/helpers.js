// utils/helpers.js - Utility functions with improved URL handling
const { QUALITY_BADGES, EMOJIS } = require('../constants');
const logger = require('./logger');

/**
 * Normalize URL for comparison - removes protocol, www, trailing slashes, query params
 * @param {string} url - URL to normalize
 * @returns {string} Normalized URL
 */
function normalizeUrlForComparison(url) {
  return url
    .replace(/^https?:\/\//, '') // Remove protocol
    .replace(/^www\./, '') // Remove www
    .replace(/\/$/, '') // Remove trailing slash
    .split('?')[0] // Remove query parameters
    .split('#')[0] // Remove hash
    .toLowerCase(); // Lowercase for comparison
}

/**
 * Detect all supported URLs in text with deduplication
 * @param {string} text - Text to search for URLs
 * @param {object} patterns - Platform patterns object
 * @returns {Array} Array of unique detected URLs with platforms
 */
function detectAllUrls(text, patterns) {
  const urls = [];
  const seenNormalizedUrls = new Map(); // Map to track normalized URL to original
  let totalMatches = 0;

  logger.debug(`🔍 Scanning message for URLs (text length: ${text.length} chars)`);

  for (const [platform, pattern] of Object.entries(patterns)) {
    const matches = text.matchAll(pattern);
    let matchCount = 0;

    for (const match of matches) {
      totalMatches++;
      matchCount++;

      let url = match[0];
      const normalizedUrl = normalizeUrlForComparison(url);

      logger.debug(`Found ${platform} match: ${url}`, { normalized: normalizedUrl });

      // Check if we've seen this normalized URL before
      if (!seenNormalizedUrls.has(normalizedUrl)) {
        seenNormalizedUrls.set(normalizedUrl, url);
        urls.push({ url, platform, normalized: normalizedUrl });
        logger.debug(`✅ Added new URL: ${url}`);
      } else {
        const firstUrl = seenNormalizedUrls.get(normalizedUrl);
        logger.debug(`🔄 DUPLICATE detected: ${url} (already seen as: ${firstUrl})`);
      }
    }

    if (matchCount > 0) {
      logger.debug(`${platform}: ${matchCount} match(es) found`);
    }
  }

  logger.info(`📊 URL Detection: ${seenNormalizedUrls.size} unique from ${totalMatches} total matches`);
  return urls;
}

/**
 * Get platform emoji
 * @param {string} platform - Platform name
 * @returns {string} Emoji for the platform
 */
function getPlatformEmoji(platform) {
  return EMOJIS[platform] || '🎬';
}

/**
 * Create visual progress bar
 * @param {number} percentage - Progress percentage
 * @param {number} length - Bar length in characters
 * @returns {string} Progress bar string
 */
function createProgressBar(percentage, length = 20) {
  const safePercentage = Math.max(0, Math.min(100, percentage));
  const filled = Math.round((safePercentage / 100) * length);
  const empty = length - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Format uptime duration
 * @param {number} seconds - Uptime in seconds
 * @returns {string} Formatted uptime string
 */
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Format bytes to human readable format
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted size string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Detect platform from URL
 * @param {string} url - URL to detect platform from
 * @returns {string} Platform name
 */
function detectPlatform(url) {
  const normalized = url.toLowerCase();
  
  if (/tiktok\.com/i.test(normalized)) return 'tiktok';
  if (/instagram\.com/i.test(normalized)) return 'instagram';
  if (/(?:twitter|x)\.com/i.test(normalized)) return 'twitter';
  if (/(?:youtube\.com|youtu\.be)/i.test(normalized)) return 'youtube';
  if (/snapchat\.com/i.test(normalized)) return 'snapchat';
  if (/facebook\.com/i.test(normalized)) return 'facebook';
  if (/reddit\.com/i.test(normalized)) return 'reddit';
  return 'default';
}

/**
 * Sanitize filename for safe file system use
 * @param {string} str - String to sanitize
 * @returns {string} Sanitized filename
 */
function sanitizeFilename(str) {
  if (!str) return 'unknown';
  return str
    .replace(/[^a-zA-Z0-9._@-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 50);
}

/**
 * Get formatted date tag for filenames
 * @returns {string} Date tag string
 */
function getDateTag() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  return `${year}${month}${day}_${hour}${minute}`;
}

/**
 * Get quality badge based on resolution
 * @param {string} resolution - Resolution string
 * @returns {string} Quality badge string
 */
function getQualityBadge(resolution) {
  if (!resolution || resolution === 'Unknown') {
    return '🎥 Video';
  }
  
  const resMatch = resolution.match(/(\d+)x(\d+)/);
  if (!resMatch) {
    return '🎥 Video';
  }
  
  const height = parseInt(resMatch[2], 10);
  
  // Find the appropriate quality badge
  for (const [key, { min, badge }] of Object.entries(QUALITY_BADGES)) {
    if (height >= min) {
      return badge;
    }
  }
  
  return '🎥 Video';
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} Promise that resolves after delay
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a timeout promise
 * @param {Promise} promise - Promise to wrap
 * @param {number} ms - Timeout in milliseconds
 * @param {string} message - Error message on timeout
 * @returns {Promise} Promise with timeout
 */
function promiseTimeout(promise, ms, message = 'Operation timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(message)), ms)
    )
  ]);
}

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} delay - Initial delay in milliseconds
 * @returns {Promise} Result of the function
 */
async function retryWithBackoff(fn, maxRetries = 3, delay = 1000) {
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        const waitTime = Math.min(delay * Math.pow(2, i), 10000);
        await sleep(waitTime);
      }
    }
  }

  throw lastError;
}

/**
 * Shorten text to a maximum length with ellipsis
 * @param {string} text - Text to shorten
 * @param {number} max - Maximum length (default 500)
 * @returns {string} Shortened text
 */
function shortenText(text, max = 500) {
  if (!text) return '';
  const trimmed = text.toString().trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 3) + '...';
}

module.exports = {
  normalizeUrlForComparison,
  detectAllUrls,
  getPlatformEmoji,
  createProgressBar,
  formatUptime,
  formatBytes,
  detectPlatform,
  sanitizeFilename,
  getDateTag,
  getQualityBadge,
  sleep,
  promiseTimeout,
  retryWithBackoff,
  shortenText
};
