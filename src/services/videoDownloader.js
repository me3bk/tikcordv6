// services/videoDownloader.js - Video download service with platform support
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const { CONFIG } = require('../config');
const logger = require('../utils/logger');
const {
  sanitizeFilename,
  getDateTag,
  detectPlatform,
  promiseTimeout,
  retryWithBackoff,
  shortenText
} = require('../utils/helpers');

const execFileAsync = promisify(execFile);

class VideoDownloader {
  constructor() {
    this.tempDir = CONFIG.PATHS.TEMP_DIR;
    this.ensureTempDir();
    this.permanentErrorPatterns = [
      'http error 403',
      'http error 404',
      '404 not found',
      '410 gone',
      '410:',
      'private video',
      'video unavailable',
      'not available in your country',
      'sign in to confirm your age',
      'playback on other websites has been disabled',
      'this live event has ended',
      'copyright claim',
      'account is private',
      'video does not exist',
      'user not found'
    ];
  }

  /**
   * Ensure temp directory exists
   */
  async ensureTempDir() {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      logger.error('Failed to create temp directory:', { error: error.message });
    }
  }

  /**
   * Check if yt-dlp is available
   * @returns {boolean} Whether yt-dlp is available
   */
  async checkYtDlp() {
    try {
      await execFileAsync('yt-dlp', ['--version'], { timeout: 5000 });
      return true;
    } catch (error) {
      logger.error('yt-dlp not available:', { error: error.message });
      return false;
    }
  }

  /**
   * Get video information
   * @param {string} url - Video URL
   * @param {Object} options - Options
   * @returns {Object} Video metadata
   */
  async getVideoInfo(url, options = {}) {
    const { tag = 'unknown' } = options;
    const platform = detectPlatform(url);

    logger.info(`[${tag}] Getting video info from ${platform}...`);

    try {
      const impersonateTarget = CONFIG.IMPERSONATE_TARGETS[platform] || CONFIG.IMPERSONATE_TARGETS.default;

      const args = [
        url,
        '--dump-json',
        '--no-warnings',
        '--socket-timeout', '30'
      ];

      // Skip impersonate - not supported by this yt-dlp build
      // Skip cookies for TikTok (works without them)
      if (platform !== 'tiktok') {
        const cookiePath = CONFIG.PATHS.COOKIES[platform];
        if (cookiePath && fsSync.existsSync(cookiePath)) {
          args.push('--cookies', cookiePath);
          logger.debug(`[${tag}] Using ${platform} cookies`);
        }
      }

      // Log the exact command for debugging
      logger.debug(`[${tag}] yt-dlp command: yt-dlp ${args.join(' ')}`);

      const { stdout } = await promiseTimeout(
        execFileAsync('yt-dlp', args, {
          maxBuffer: 10 * 1024 * 1024
        }),
        CONFIG.DOWNLOAD.INFO_TIMEOUT,
        'Video info retrieval timed out'
      );

      const info = JSON.parse(stdout);

      logger.info(`[${tag}] Video info retrieved: ${info.title || 'Unknown'}`);

      return {
        title: info.title || 'video',
        description: info.description || null,
        duration: info.duration || 0,
        uploader: info.uploader || info.uploader_id || info.channel || 'unknown_user',
        uploaderId: info.uploader_id || info.channel_id || null,
        platform: platform,
        url: url,
        resolution: info.resolution || null,
        filesize: info.filesize || info.filesize_approx || null
      };

    } catch (error) {
      // Enhanced error logging to capture full details
      const errorDetails = {
        message: error.message || 'Unknown error',
        code: error.code || 'N/A',
        stderr: error.stderr?.toString() || 'none',
        stdout: error.stdout?.toString() || 'none'
      };
      logger.error(`[${tag}] Failed to get video info:`, errorDetails);
      
      // Return basic metadata on error
      return {
        title: 'video',
        uploader: 'unknown_user',
        platform: platform,
        url: url
      };
    }
  }

  /**
   * Download video with yt-dlp
   * @param {string} url - Video URL
   * @param {Object} options - Download options
   * @returns {Object} Download result
   */
  async downloadVideo(url, options = {}) {
    const { tag = 'unknown', onProgress, retries = 0, youtubeOptions } = options;
    const platform = detectPlatform(url);

    logger.info(`[${tag}] Starting download from ${platform}...`);

    if (retries > 0) {
      return await this.downloadWithRetry(url, options);
    }

    await this.ensureTempDir();

    let outPath = null;
    
    try {
      // Get metadata first
      const metadata = await this.getVideoInfo(url, { tag });
      
      // Generate filename
      const username = sanitizeFilename(metadata.uploader || metadata.uploaderId || 'unknown_user');
      let caption = shortenText(metadata.description || metadata.title || null, 200);

      const dateTag = getDateTag();

      // Use youtubeService for YouTube custom downloads
      let args;
      let fileExt = 'mp4';

      if (platform === 'youtube' && youtubeOptions && youtubeOptions.formatOptions) {
        const youtubeService = require('./youtubeService');
        const { formatOptions } = youtubeOptions;
        fileExt = formatOptions.ext || 'mp4';

        const fileName = `${username}_${dateTag}_${tag}.${fileExt}`;
        outPath = path.join(this.tempDir, fileName);

        logger.info(`[${tag}] Downloading YouTube with ${formatOptions.description}: ${fileName}`);

        args = youtubeService.buildYtDlpArgs(url, outPath, formatOptions);
      } else {
        const fileName = `${username}_${dateTag}_${tag}.mp4`;
        outPath = path.join(this.tempDir, fileName);

        logger.info(`[${tag}] Downloading with yt-dlp: ${fileName}`);

        // Get platform-specific arguments
        const platformArgs = this.getPlatformArgs(platform, url);
        args = [
          url,
          ...platformArgs,
          '-o', outPath,
          '--progress',
          '--newline'
        ];
      }

      // Log the exact command for debugging
      logger.debug(`[${tag}] yt-dlp download command: yt-dlp ${args.join(' ')}`);

      // Execute yt-dlp
      let lastYtDlpError = '';
      const ytDlp = execFile('yt-dlp', args, {
        timeout: CONFIG.DOWNLOAD.TIMEOUT,
        maxBuffer: CONFIG.DOWNLOAD.MAX_BUFFER_SIZE
      });
      
      // Handle progress updates
      let lastProgress = 0;
      ytDlp.stdout.on('data', (data) => {
        const output = data.toString();
        const progressMatch = output.match(/\[(\d+\.?\d*)%\]/);
        if (progressMatch && onProgress) {
          const progress = parseFloat(progressMatch[1]);
          if (progress > lastProgress) {
            lastProgress = progress;
            onProgress(Math.min(progress, 99));
          }
        }
      });
      
      // Log errors but don't fail
      ytDlp.stderr.on('data', (data) => {
        const errorText = data.toString();
        const trimmed = errorText.trim();
        if (trimmed) {
          lastYtDlpError = trimmed;
        }
        if (errorText.includes('ERROR')) {
          logger.error(`[${tag}] yt-dlp error:`, { error: trimmed || errorText });
        }
      });
      
      // Wait for completion
      await new Promise((resolve, reject) => {
        ytDlp.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            const message = this.buildYtDlpErrorMessage(code, lastYtDlpError);
            const err = new Error(message);
            if (this.isPermanentYtDlpError(lastYtDlpError)) {
              err.isPermanent = true;
            }
            err.rawOutput = lastYtDlpError;
            reject(err);
          }
        });
        ytDlp.on('error', reject);
      });
      
      // Verify file exists and has content
      if (!fsSync.existsSync(outPath)) {
        throw new Error('Downloaded file not found');
      }
      
      const stats = fsSync.statSync(outPath);
      if (stats.size === 0) {
        throw new Error('Downloaded file is empty');
      }
      
      logger.info(`[${tag}] ✅ Download completed: ${fileName} (${(stats.size/1024/1024).toFixed(2)}MB)`);
      
      if (onProgress) onProgress(100);
      
      return {
        path: outPath,
        size: stats.size,
        filename: fileName,
        platform: platform,
        metadata: {
          uploader: username,
          caption: caption,
          resolution: metadata.resolution
        }
      };

    } catch (error) {
      // Enhanced error logging to capture full details
      const errorDetails = {
        message: error.message || 'Unknown error',
        isPermanent: error.isPermanent || false,
        rawOutput: error.rawOutput || 'none',
        code: error.code || 'N/A'
      };
      logger.error(`[${tag}] yt-dlp download failed:`, errorDetails);
      
      // Clean up failed download
      if (outPath && fsSync.existsSync(outPath)) {
        try {
          await fs.unlink(outPath);
        } catch (cleanupError) {
          logger.debug(`[${tag}] Failed to cleanup:`, { error: cleanupError.message });
        }
      }
      
      // Try fallback APIs for supported platforms
      if (platform === 'tiktok') {
        logger.info(`[${tag}] 🔄 Switching to TikTok API fallback...`);
        return await this.downloadTikTokViaAPI(url, options);
      } else if (platform === 'instagram' && CONFIG.API.RAPIDAPI_KEY) {
        logger.info(`[${tag}] 🔄 Switching to Instagram API fallback...`);
        return await this.downloadInstagramViaAPI(url, options);
      }
      
      throw error;
    }
  }

  /**
   * Download with retry logic
   * @param {string} url - Video URL
   * @param {Object} options - Download options
   * @returns {Object} Download result
   */
  async downloadWithRetry(url, options = {}) {
    const { tag = 'unknown', retries = CONFIG.DOWNLOAD.MAX_RETRIES } = options;
    const platform = detectPlatform(url);
    
    return await retryWithBackoff(
      async () => {
        return await this.downloadVideo(url, { ...options, retries: 0 });
      },
      retries,
      1000
    ).catch(async (error) => {
      // Try API fallback as last resort
      if (platform === 'tiktok') {
        try {
          return await this.downloadTikTokViaAPI(url, options);
        } catch (apiError) {
          logger.error(`[${tag}] All download methods failed`);
          throw error; // Throw original error
        }
      } else if (platform === 'instagram' && CONFIG.API.RAPIDAPI_KEY) {
        try {
          return await this.downloadInstagramViaAPI(url, options);
        } catch (apiError) {
          logger.error(`[${tag}] All download methods failed`);
          throw error;
        }
      }
      throw error;
    });
  }

  /**
   * Get platform-specific yt-dlp arguments
   * @param {string} platform - Platform name
   * @param {string} url - Video URL
   * @returns {Array} yt-dlp arguments
   */
  getPlatformArgs(platform, url) {
    const formatList = CONFIG.FORMATS[platform] || CONFIG.FORMATS.default;
    const formatString = formatList.join('/');
    const impersonateTarget = CONFIG.IMPERSONATE_TARGETS[platform] || CONFIG.IMPERSONATE_TARGETS.default;

    const baseArgs = [
      '--format', formatString,
      '--no-warnings',
      '--no-playlist',
      '--socket-timeout', '60',
      '--retries', '10',
      '--fragment-retries', '20',
      '--add-header', 'Accept:*/*',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--merge-output-format', 'mp4',
      '--concurrent-fragments', platform === 'snapchat' ? '3' : '32', // ✅ Increased for 1Gbps
      '--buffer-size', '32K', // ✅ Larger buffer for fast network
      '--no-part'
    ];

    // Skip impersonate - not supported by this yt-dlp build
    
    // Platform-specific arguments
    switch (platform) {
      case 'tiktok':
        baseArgs.push(
          '--referer', 'https://www.tiktok.com/',
          '--no-check-certificates',
          '--http-chunk-size', '10M'
        );
        break;
        
      case 'instagram':
        baseArgs.push('--referer', 'https://www.instagram.com/');
        break;
        
      case 'youtube':
        baseArgs.push('--no-playlist', '--prefer-free-formats');
        break;
        
      case 'snapchat':
        baseArgs.push(
          '--http-chunk-size', '5M',
          '--retries', '10',
          '--fragment-retries', '25',
          '--socket-timeout', '90',
          '--geo-bypass',
          '--no-check-certificates'
        );
        break;
    }

    // Add cookies if available (but skip for TikTok - works without cookies)
    if (platform !== 'tiktok') {
      const cookiePath = CONFIG.PATHS.COOKIES[platform];
      if (cookiePath && fsSync.existsSync(cookiePath)) {
        baseArgs.push('--cookies', cookiePath);
      }
    }

    return baseArgs;
  }

  /**
   * Download TikTok via API fallback
   * @param {string} url - TikTok URL
   * @param {Object} options - Download options
   * @returns {Object} Download result
   */
  async downloadTikTokViaAPI(url, options = {}) {
    const { tag = 'unknown' } = options;
    
    try {
      logger.info(`[${tag}] 🔄 Trying TikTok API fallback (tikwm.com)...`);
      
      const response = await axios.post('https://www.tikwm.com/api/', {
        url: url,
        hd: 1
      }, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 30000
      });
      
      if (response.data.code === 0 && response.data.data?.play) {
        const videoUrl = response.data.data.play;
        const username = response.data.data.author?.unique_id || 'tiktok_user';
        const caption = response.data.data.title || null;
        
        const dateTag = getDateTag();
        const fileName = `${sanitizeFilename(username)}_${dateTag}_${tag}.mp4`;
        const outPath = path.join(this.tempDir, fileName);
        
        await this.ensureTempDir();
        
        // Download video file
        logger.info(`[${tag}] Downloading from API: ${fileName}`);
        
        const writer = fsSync.createWriteStream(outPath);
        const videoResponse = await axios({
          url: videoUrl,
          method: 'GET',
          responseType: 'stream',
          timeout: CONFIG.DOWNLOAD.TIMEOUT,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        
        videoResponse.data.pipe(writer);
        
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        
        // Verify download
        if (!fsSync.existsSync(outPath)) {
          throw new Error('API download failed - file not created');
        }
        
        const stats = fsSync.statSync(outPath);
        if (stats.size === 0) {
          throw new Error('API download failed - empty file');
        }
        
        logger.info(`[${tag}] ✅ Downloaded via TikTok API: ${fileName} (${(stats.size/1024/1024).toFixed(2)}MB)`);
        
        return {
          path: outPath,
          size: stats.size,
          filename: fileName,
          platform: 'tiktok',
          metadata: {
            uploader: username,
            caption: caption,
            resolution: '720p'
          }
        };
      }
      
      throw new Error('TikTok API returned invalid response');
      
    } catch (error) {
      const apiError = this.normalizeApiError(error, 'TikTok API fallback failed');
      logger.error(`[${tag}] TikTok API fallback failed:`, { error: apiError.message });
      throw apiError;
    }
  }

  /**
   * Download Instagram via API fallback
   * @param {string} url - Instagram URL
   * @param {Object} options - Download options
   * @returns {Object} Download result
   */
  async downloadInstagramViaAPI(url, options = {}) {
    const { tag = 'unknown' } = options;
    
    if (!CONFIG.API.RAPIDAPI_KEY) {
      throw new Error('Instagram API requires RAPIDAPI_KEY');
    }
    
    try {
      logger.info(`[${tag}] 🔄 Trying Instagram RapidAPI (instagram120)...`);
      
      const response = await axios.post('https://instagram120.p.rapidapi.com/api/instagram/links', {
        url: url
      }, {
        headers: {
          'x-rapidapi-key': CONFIG.API.RAPIDAPI_KEY,
          'x-rapidapi-host': 'instagram120.p.rapidapi.com',
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });
      
      // Parse response structure
      if (response.data && Array.isArray(response.data) && response.data.length > 0) {
        const dataObj = response.data[0];
        
        if (!dataObj.urls || !Array.isArray(dataObj.urls) || dataObj.urls.length === 0) {
          throw new Error('No URLs found in API response');
        }
        
        const videoUrl = dataObj.urls[0].url;
        const username = dataObj.meta?.username || 'instagram';
        
        const dateTag = getDateTag();
        const fileName = `${sanitizeFilename(username)}_${dateTag}_${tag}.mp4`;
        const outPath = path.join(this.tempDir, fileName);
        
        await this.ensureTempDir();
        
        // Download video
        logger.info(`[${tag}] Downloading from RapidAPI...`);
        
        const writer = fsSync.createWriteStream(outPath);
        const videoResponse = await axios({
          url: videoUrl,
          method: 'GET',
          responseType: 'stream',
          timeout: CONFIG.DOWNLOAD.TIMEOUT
        });
        
        videoResponse.data.pipe(writer);
        
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        
        const stats = fsSync.statSync(outPath);
        
        logger.info(`[${tag}] ✅ Downloaded via Instagram API: ${fileName} (${(stats.size/1024/1024).toFixed(2)}MB)`);
        
        return {
          path: outPath,
          size: stats.size,
          filename: fileName,
          platform: 'instagram',
          metadata: {
            uploader: username,
            caption: null,
            resolution: '720p'
          }
        };
      }
      
      throw new Error('Instagram API returned invalid data structure');
      
    } catch (error) {
      const apiError = this.normalizeApiError(error, 'Instagram API fallback failed');
      logger.error(`[${tag}] Instagram API fallback failed:`, { error: apiError.message });
      throw apiError;
    }
  }

  /**
   * Clean up a downloaded file
   * @param {string} filePath - Path to file to clean up
   */
  async cleanup(filePath) {
    try {
      await fs.unlink(filePath);
      logger.debug(`Cleaned up: ${filePath}`);
    } catch (error) {
      logger.warn(`Cleanup failed:`, { error: error.message });
    }
  }

  /**
   * Clean up old files
   * @param {number} maxAgeHours - Maximum age in hours
   */
  async cleanupOldFiles(maxAgeHours = 24) {
    try {
      await this.ensureTempDir();
      const files = await fs.readdir(this.tempDir);
      const now = Date.now();
      const maxAge = maxAgeHours * 60 * 60 * 1000;

      let cleaned = 0;
      let freedBytes = 0;

      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        try {
          const stats = await fs.stat(filePath);
          const age = now - stats.mtimeMs;

          if (age > maxAge) {
            freedBytes += stats.size;
            await fs.unlink(filePath);
            cleaned++;
          }
        } catch (error) {
          // Skip files that can't be accessed
          continue;
        }
      }

      if (cleaned > 0) {
        const freedMB = (freedBytes / 1024 / 1024).toFixed(1);
        logger.info(`🧹 Cleaned up ${cleaned} files (${freedMB}MB freed)`);
      }

    } catch (error) {
      logger.error(`Cleanup failed:`, { error: error.message });
    }
  }

  /**
   * Aggressive cleanup based on total size
   * Deletes oldest files if total temp size exceeds limit
   */
  async aggressiveCleanup() {
    try {
      await this.ensureTempDir();
      const files = await fs.readdir(this.tempDir);
      const now = Date.now();

      let totalSize = 0;
      const fileStats = [];

      // Get all files with stats
      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        try {
          const stats = await fs.stat(filePath);
          totalSize += stats.size;
          fileStats.push({
            path: filePath,
            size: stats.size,
            mtime: stats.mtimeMs,
            name: file
          });
        } catch (error) {
          continue;
        }
      }

      const totalSizeMB = totalSize / 1024 / 1024;
      const maxSizeMB = CONFIG.DOWNLOAD.MAX_TEMP_SIZE_MB || 500;

      // If exceeds limit, delete oldest files
      if (totalSizeMB > maxSizeMB) {
        logger.warn(`⚠️ Temp dir too large: ${totalSizeMB.toFixed(1)}MB / ${maxSizeMB}MB`);

        // Sort by modification time (oldest first)
        fileStats.sort((a, b) => a.mtime - b.mtime);

        let deletedCount = 0;
        let freedBytes = 0;

        for (const { path: filePath, size, name } of fileStats) {
          try {
            await fs.unlink(filePath);
            totalSize -= size;
            freedBytes += size;
            deletedCount++;

            logger.debug(`Deleted old file: ${name} (${(size/1024/1024).toFixed(1)}MB)`);

            // Stop when under 70% of limit
            if (totalSize / 1024 / 1024 < maxSizeMB * 0.7) {
              break;
            }
          } catch (error) {
            // Continue if can't delete
            continue;
          }
        }

        const freedMB = (freedBytes / 1024 / 1024).toFixed(1);
        logger.info(`🧹 Aggressive cleanup: ${deletedCount} files deleted (${freedMB}MB freed)`);
      }

    } catch (error) {
      logger.error(`Aggressive cleanup failed:`, { error: error.message });
    }
  }

  /**
   * Update yt-dlp
   * @returns {boolean} Whether update was successful
   */
  async updateYtDlp() {
    const startTime = Date.now();
    logger.info('🔄 Checking for yt-dlp updates...');
    
    try {
      const { stdout: currentVersion } = await execFileAsync('yt-dlp', ['--version']);
      logger.info(`Current yt-dlp version: ${currentVersion.trim()}`);
      
      const { stdout } = await execFileAsync('yt-dlp', ['-U'], {
        timeout: 60000
      });
      
      const updateTime = ((Date.now() - startTime) / 1000).toFixed(2);
      
      if (stdout.includes('Updated') || stdout.includes('Installing')) {
        const { stdout: newVersion } = await execFileAsync('yt-dlp', ['--version']);
        logger.info(`✅ yt-dlp updated: ${currentVersion.trim()} → ${newVersion.trim()} (${updateTime}s)`);
        return true;
      } else {
        logger.info(`✔ yt-dlp already up to date (${updateTime}s)`);
        return false;
      }
      
    } catch (error) {
      logger.error('❌ yt-dlp update failed:', { error: error.message });
      return false;
    }
  }

  buildYtDlpErrorMessage(code, lastError = '') {
    if (lastError) {
      return `yt-dlp exited with code ${code}: ${lastError}`;
    }
    return `yt-dlp exited with code ${code}`;
  }

  isPermanentYtDlpError(output = '') {
    if (!output) return false;
    const lower = output.toLowerCase();
    return this.permanentErrorPatterns.some(pattern => lower.includes(pattern));
  }

  normalizeApiError(error, prefix = 'API error') {
    const status = error?.response?.status;
    const statusText = status ? `status ${status}` : null;
    const pieces = [prefix, statusText, error?.message].filter(Boolean);
    const normalized = new Error(pieces.join(' - '));
    if (status && [400, 401, 403, 404, 410, 451].includes(status)) {
      normalized.isPermanent = true;
    }
    return normalized;
  }
}

// Create singleton instance
const videoDownloader = new VideoDownloader();

module.exports = videoDownloader;
