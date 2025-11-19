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
        '--socket-timeout', '30'
      ];

      // Add verbose for TikTok debugging
      if (platform === 'tiktok') {
        args.push('--verbose');
      }

      // Add YouTube bypass for bot detection
      if (platform === 'youtube') {
        args.push(
          '--extractor-args', 'youtube:player_client=default,web',
          '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        );
      }

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
      logger.info(`[${tag}] yt-dlp info command: yt-dlp ${args.join(' ')}`);

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

    // For YouTube, skip yt-dlp entirely and use API directly
    if (platform === 'youtube') {
      logger.info(`[${tag}] Using YouTube API (yt-dlp unreliable for YouTube)`);
      return await this.downloadYouTubeViaAPI(url, options);
    }

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
      let fileName; // Declare fileName in function scope

      if (platform === 'youtube' && youtubeOptions && youtubeOptions.formatOptions) {
        const youtubeService = require('./youtubeService');
        const { formatOptions } = youtubeOptions;
        fileExt = formatOptions.ext || 'mp4';

        fileName = `${username}_${dateTag}_${tag}.${fileExt}`;
        outPath = path.join(this.tempDir, fileName);

        logger.info(`[${tag}] Downloading YouTube with ${formatOptions.description}: ${fileName}`);

        args = youtubeService.buildYtDlpArgs(url, outPath, formatOptions);
      } else {
        fileName = `${username}_${dateTag}_${tag}.mp4`;
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
      let allStderr = '';
      let allStdout = '';

      const ytDlp = execFile('yt-dlp', args, {
        timeout: CONFIG.DOWNLOAD.TIMEOUT,
        maxBuffer: CONFIG.DOWNLOAD.MAX_BUFFER_SIZE
      });

      // Handle progress updates
      let lastProgress = 0;
      ytDlp.stdout.on('data', (data) => {
        const output = data.toString();
        allStdout += output; // Capture everything

        const progressMatch = output.match(/\[(\d+\.?\d*)%\]/);
        if (progressMatch && onProgress) {
          const progress = parseFloat(progressMatch[1]);
          if (progress > lastProgress) {
            lastProgress = progress;
            onProgress(Math.min(progress, 99));
          }
        }
      });

      // Capture ALL stderr output
      ytDlp.stderr.on('data', (data) => {
        const errorText = data.toString();
        allStderr += errorText; // Capture everything

        const trimmed = errorText.trim();
        if (trimmed) {
          lastYtDlpError = trimmed;

          // Log ALL stderr for debugging (especially TikTok)
          if (platform === 'tiktok') {
            logger.info(`[${tag}] yt-dlp output: ${trimmed}`);
          }
        }

        if (errorText.includes('ERROR')) {
          logger.error(`[${tag}] yt-dlp ERROR:`, { error: trimmed });
        }
      });

      // Wait for completion
      await new Promise((resolve, reject) => {
        ytDlp.on('close', (code) => {
          if (code === 0) {
            logger.info(`[${tag}] yt-dlp process exited successfully (code 0)`);
            resolve();
          } else {
            // Build detailed error with ALL captured output
            const message = this.buildYtDlpErrorMessage(code, lastYtDlpError);
            const err = new Error(message);

            if (this.isPermanentYtDlpError(lastYtDlpError)) {
              err.isPermanent = true;
            }

            err.rawOutput = lastYtDlpError;
            err.exitCode = code;
            err.fullStderr = allStderr;
            err.fullStdout = allStdout;

            // Log FULL details for debugging
            logger.error(`[${tag}] yt-dlp failed with exit code ${code}`);
            logger.error(`[${tag}] Last error: ${lastYtDlpError || 'none'}`);
            logger.error(`[${tag}] Full stderr (last 500 chars): ${allStderr.slice(-500) || 'none'}`);
            if (allStdout) {
              logger.debug(`[${tag}] Full stdout (last 200 chars): ${allStdout.slice(-200)}`);
            }

            reject(err);
          }
        });

        ytDlp.on('error', (err) => {
          logger.error(`[${tag}] yt-dlp process error:`, {
            error: err.message,
            code: err.code,
            stderr: allStderr.slice(-500) || 'none'
          });
          reject(err);
        });
      });

      logger.debug(`[${tag}] Verifying downloaded file: ${outPath}`);

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
      logger.error(`[${tag}] yt-dlp download failed: ${error.message || 'Unknown error'}`);
      logger.error(`[${tag}] Error code: ${error.code || error.exitCode || 'N/A'}`);
      logger.error(`[${tag}] Is permanent: ${error.isPermanent || false}`);

      // Log full stderr/stdout if available
      if (error.fullStderr) {
        logger.error(`[${tag}] Full stderr (last 1000 chars):\n${error.fullStderr.slice(-1000)}`);
      }
      if (error.fullStdout) {
        logger.error(`[${tag}] Full stdout (last 500 chars):\n${error.fullStdout.slice(-500)}`);
      }
      if (error.rawOutput) {
        logger.error(`[${tag}] Raw output: ${error.rawOutput}`);
      }
      
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
      } else if (platform === 'youtube') {
        logger.info(`[${tag}] 🔄 Switching to YouTube API fallback...`);
        return await this.downloadYouTubeViaAPI(url, options);
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
      } else if (platform === 'youtube') {
        try {
          return await this.downloadYouTubeViaAPI(url, options);
        } catch (apiError) {
          logger.error(`[${tag}] All download methods failed`);
          throw error;
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
          '--verbose',  // ✅ Enable verbose output for debugging
          '--referer', 'https://www.tiktok.com/',
          '--no-check-certificates',
          '--http-chunk-size', '10M'
        );
        break;
        
      case 'instagram':
        baseArgs.push('--referer', 'https://www.instagram.com/');
        break;
        
      case 'youtube':
        baseArgs.push(
          '--no-playlist',
          '--prefer-free-formats',
          '--extractor-args', 'youtube:player_client=default,web',  // ✅ Bypass bot detection
          '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        );
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
   * Download YouTube via API (primary method - yt-dlp unreliable)
   * @param {string} url - YouTube URL
   * @param {Object} options - Download options
   * @returns {Object} Download result
   */
  async downloadYouTubeViaAPI(url, options = {}) {
    const { tag = 'unknown', youtubeOptions } = options;

    // Determine quality and format
    let isAudioOnly = false;
    let quality = '720'; // Default to 720p

    if (youtubeOptions && youtubeOptions.quality) {
      isAudioOnly = youtubeOptions.quality === 'audio';
      const qualityMap = {
        '720p': '720',
        '1080p': '1080',
        '1440p': '1440',
        '2160p': '2160',
        'best': '1080'
      };
      quality = qualityMap[youtubeOptions.quality] || '720';
    }

    // Try multiple APIs in order (only working APIs)
    const apis = [
      { name: 'vidfly.ai', fn: () => this.downloadYouTubeViaVidfly(url, tag, quality, isAudioOnly) }
      // yt5s.io, y2mate.nu, loader.to all return 404/400 errors - removed
    ];

    let lastError = null;

    for (const api of apis) {
      try {
        logger.info(`[${tag}] 🔄 Trying YouTube API (${api.name})...`);
        const result = await api.fn();
        logger.info(`[${tag}] ✅ Downloaded via ${api.name}: ${result.filename} (${(result.size/1024/1024).toFixed(2)}MB)`);
        return result;
      } catch (error) {
        logger.warn(`[${tag}] ${api.name} failed: ${error.message}`);
        lastError = error;
        continue;
      }
    }

    // All APIs failed
    const apiError = this.normalizeApiError(lastError, 'All YouTube APIs failed');
    logger.error(`[${tag}] All YouTube APIs failed`);
    throw apiError;
  }

  /**
   * Download YouTube via vidfly.ai API (fastest and most reliable)
   */
  async downloadYouTubeViaVidfly(url, tag, quality, isAudioOnly) {
    try {
      // Extract video ID
      const videoId = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/)?.[1];
      if (!videoId) {
        throw new Error('Invalid YouTube URL');
      }

      // Get video data from vidfly.ai
      const response = await axios.get('https://api.vidfly.ai/api/media/youtube/download', {
        params: { url },
        headers: {
          'accept': '*/*',
          'content-type': 'application/json',
          'x-app-name': 'vidfly-web',
          'x-app-version': '1.0.0',
          'Referer': 'https://vidfly.ai/'
        },
        timeout: 30000
      });

      // Debug logging
      logger.debug(`[${tag}] vidfly.ai response status: ${response.data?.status || 'unknown'}`);
      logger.debug(`[${tag}] vidfly.ai has data: ${!!response.data?.data}`);

      if (!response.data || response.data.status === 'error') {
        throw new Error(response.data?.message || 'vidfly.ai returned error');
      }

      if (!response.data.data) {
        throw new Error('vidfly.ai returned invalid response structure');
      }

      const data = response.data.data;
      const title = data.title || 'video';

      // vidfly.ai uses "items" not "formats"
      const items = data.items || [];
      logger.debug(`[${tag}] vidfly.ai items available: ${items.length}`);

      if (items.length === 0) {
        logger.error(`[${tag}] vidfly.ai response structure: ${JSON.stringify(data, null, 2).substring(0, 500)}`);
        throw new Error('No items found in vidfly.ai response');
      }

      // Find best quality video
      let downloadUrl;
      const requestedHeight = parseInt(quality);
      logger.debug(`[${tag}] Requested quality: ${quality}p (height: ${requestedHeight}), Audio only: ${isAudioOnly}`);

      // Filter items with video
      const videoItems = items.filter(item => item.type?.includes('video') || item.height);

      if (videoItems.length > 0) {
        // Try to find exact quality match by height
        let selectedItem = videoItems.find(item => item.height === requestedHeight);

        // If not found, get closest or best quality
        if (!selectedItem) {
          // Sort by height descending (best quality first)
          videoItems.sort((a, b) => (b.height || 0) - (a.height || 0));
          selectedItem = videoItems[0];
          logger.debug(`[${tag}] Using fallback quality: ${selectedItem.height}p (${selectedItem.label})`);
        } else {
          logger.debug(`[${tag}] Found exact match: ${selectedItem.height}p (${selectedItem.label})`);
        }

        downloadUrl = selectedItem.url;
      }

      if (!downloadUrl) {
        logger.error(`[${tag}] vidfly.ai response structure: ${JSON.stringify(data, null, 2).substring(0, 500)}`);
        throw new Error('No suitable download link found');
      }

      // Download the file
      const dateTag = getDateTag();
      const tempExt = 'mp4'; // Always download as MP4 first
      const finalExt = isAudioOnly ? 'mp3' : 'mp4';
      const tempFileName = `${sanitizeFilename(title)}_${dateTag}_${tag}_temp.${tempExt}`;
      const finalFileName = `${sanitizeFilename(title)}_${dateTag}_${tag}.${finalExt}`;
      const tempPath = path.join(this.tempDir, tempFileName);
      const finalPath = path.join(this.tempDir, finalFileName);

      await this.ensureTempDir();

      logger.info(`[${tag}] Downloading from vidfly.ai: ${tempFileName}`);

      const writer = fsSync.createWriteStream(tempPath);
      const videoResponse = await axios({
        url: downloadUrl,
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
      if (!fsSync.existsSync(tempPath)) {
        throw new Error('Download failed - file not created');
      }

      const tempStats = fsSync.statSync(tempPath);
      if (tempStats.size === 0) {
        throw new Error('Download failed - empty file');
      }

      // If audio only, extract audio using ffmpeg
      if (isAudioOnly) {
        logger.info(`[${tag}] Extracting audio to MP3...`);

        try {
          const { execFile } = require('child_process');
          const { promisify } = require('util');
          const execFileAsync = promisify(execFile);

          await execFileAsync('ffmpeg', [
            '-i', tempPath,
            '-vn', // No video
            '-ar', '44100', // Audio sample rate
            '-ac', '2', // Audio channels
            '-b:a', '192k', // Audio bitrate
            '-f', 'mp3',
            finalPath
          ], { timeout: 120000 });

          // Delete temp video file
          await fs.unlink(tempPath);

          // Verify MP3 file
          if (!fsSync.existsSync(finalPath)) {
            throw new Error('MP3 extraction failed - file not created');
          }

          const finalStats = fsSync.statSync(finalPath);
          if (finalStats.size === 0) {
            throw new Error('MP3 extraction failed - empty file');
          }

          logger.info(`[${tag}] ✅ Audio extracted: ${finalFileName} (${(finalStats.size/1024/1024).toFixed(2)}MB)`);

          return {
            path: finalPath,
            size: finalStats.size,
            filename: finalFileName,
            platform: 'youtube',
            metadata: {
              uploader: data.author || 'youtube',
              caption: data.description || null,
              resolution: 'audio'
            }
          };

        } catch (ffmpegError) {
          logger.warn(`[${tag}] ffmpeg extraction failed: ${ffmpegError.message}, using video file`);

          // Clean up temp file if it still exists
          if (fsSync.existsSync(tempPath)) {
            await fs.rename(tempPath, finalPath);
          }

          const fallbackStats = fsSync.statSync(finalPath);

          return {
            path: finalPath,
            size: fallbackStats.size,
            filename: finalFileName.replace('.mp3', '.mp4'),
            platform: 'youtube',
            metadata: {
              uploader: data.author || 'youtube',
              caption: data.description || null,
              resolution: quality + 'p'
            }
          };
        }
      } else {
        // Video download - just rename temp to final
        await fs.rename(tempPath, finalPath);
        const finalStats = fsSync.statSync(finalPath);

        return {
          path: finalPath,
          size: finalStats.size,
          filename: finalFileName,
          platform: 'youtube',
          metadata: {
            uploader: data.author || 'youtube',
            caption: data.description || null,
            resolution: quality + 'p'
          }
        };
      }

    } catch (error) {
      throw new Error(`vidfly.ai: ${error.message}`);
    }
  }

  /**
   * Download YouTube via yt5s.io API
   */
  async downloadYouTubeViaYt5s(url, tag, quality, isAudioOnly) {
    try {
      // Extract video ID
      const videoId = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/)?.[1];
      if (!videoId) {
        throw new Error('Invalid YouTube URL');
      }

      // Get download links
      const analyzeResponse = await axios.post('https://yt5s.io/api/ajaxSearch',
        `q=${encodeURIComponent(url)}&vt=${isAudioOnly ? 'mp3' : 'mp4'}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 30000
        }
      );

      if (analyzeResponse.data.status !== 'ok') {
        throw new Error('yt5s.io analyze failed');
      }

      // Find best quality link
      const links = analyzeResponse.data.links;
      let downloadKey;

      if (isAudioOnly && links.mp3) {
        // Get best audio quality
        const audioQualities = Object.keys(links.mp3);
        downloadKey = links.mp3[audioQualities[0]]?.k;
      } else if (links.mp4) {
        // Get requested video quality or best available
        const videoQualities = Object.keys(links.mp4);
        const requestedQuality = quality + 'p';

        if (links.mp4[requestedQuality]) {
          downloadKey = links.mp4[requestedQuality].k;
        } else {
          // Fallback to best available
          downloadKey = links.mp4[videoQualities[0]]?.k;
        }
      }

      if (!downloadKey) {
        throw new Error('No suitable download link found');
      }

      // Convert the download key
      const convertResponse = await axios.post('https://yt5s.io/api/ajaxConvert',
        `vid=${videoId}&k=${downloadKey}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 60000
        }
      );

      if (convertResponse.data.status !== 'ok' || !convertResponse.data.dlink) {
        throw new Error('yt5s.io convert failed');
      }

      const downloadUrl = convertResponse.data.dlink;
      const title = analyzeResponse.data.title || 'video';

      // Download the file
      const dateTag = getDateTag();
      const ext = isAudioOnly ? 'mp3' : 'mp4';
      const fileName = `${sanitizeFilename(title)}_${dateTag}_${tag}.${ext}`;
      const outPath = path.join(this.tempDir, fileName);

      await this.ensureTempDir();

      logger.info(`[${tag}] Downloading from yt5s.io: ${fileName}`);

      const writer = fsSync.createWriteStream(outPath);
      const videoResponse = await axios({
        url: downloadUrl,
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
        throw new Error('Download failed - file not created');
      }

      const stats = fsSync.statSync(outPath);
      if (stats.size === 0) {
        throw new Error('Download failed - empty file');
      }

      return {
        path: outPath,
        size: stats.size,
        filename: fileName,
        platform: 'youtube',
        metadata: {
          uploader: 'youtube',
          caption: null,
          resolution: isAudioOnly ? 'audio' : quality + 'p'
        }
      };

    } catch (error) {
      throw new Error(`yt5s.io: ${error.message}`);
    }
  }

  /**
   * Download YouTube via y2mate.nu API
   */
  async downloadYouTubeViaY2mate(url, tag, quality, isAudioOnly) {
    try {
      // Extract video ID
      const videoId = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/)?.[1];
      if (!videoId) {
        throw new Error('Invalid YouTube URL');
      }

      // Analyze video
      const analyzeResponse = await axios.post('https://www.y2mate.nu/api/ajaxSearch',
        `q=${encodeURIComponent(url)}&vt=${isAudioOnly ? 'mp3' : 'mp4'}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 30000
        }
      );

      if (analyzeResponse.data.status !== 'ok') {
        throw new Error('y2mate.nu analyze failed');
      }

      const links = analyzeResponse.data.links;
      let downloadKey;

      if (isAudioOnly && links.mp3) {
        const audioQualities = Object.keys(links.mp3);
        downloadKey = links.mp3[audioQualities[0]]?.k;
      } else if (links.mp4) {
        const videoQualities = Object.keys(links.mp4);
        const requestedQuality = quality + 'p';

        if (links.mp4[requestedQuality]) {
          downloadKey = links.mp4[requestedQuality].k;
        } else {
          downloadKey = links.mp4[videoQualities[0]]?.k;
        }
      }

      if (!downloadKey) {
        throw new Error('No suitable download link found');
      }

      // Convert
      const convertResponse = await axios.post('https://www.y2mate.nu/api/ajaxConvert',
        `vid=${videoId}&k=${downloadKey}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 60000
        }
      );

      if (convertResponse.data.status !== 'ok' || !convertResponse.data.dlink) {
        throw new Error('y2mate.nu convert failed');
      }

      const downloadUrl = convertResponse.data.dlink;
      const title = analyzeResponse.data.title || 'video';

      // Download
      const dateTag = getDateTag();
      const ext = isAudioOnly ? 'mp3' : 'mp4';
      const fileName = `${sanitizeFilename(title)}_${dateTag}_${tag}.${ext}`;
      const outPath = path.join(this.tempDir, fileName);

      await this.ensureTempDir();

      logger.info(`[${tag}] Downloading from y2mate.nu: ${fileName}`);

      const writer = fsSync.createWriteStream(outPath);
      const videoResponse = await axios({
        url: downloadUrl,
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

      const stats = fsSync.statSync(outPath);

      return {
        path: outPath,
        size: stats.size,
        filename: fileName,
        platform: 'youtube',
        metadata: {
          uploader: 'youtube',
          caption: null,
          resolution: isAudioOnly ? 'audio' : quality + 'p'
        }
      };

    } catch (error) {
      throw new Error(`y2mate.nu: ${error.message}`);
    }
  }

  /**
   * Download YouTube via loader.to API (most reliable fallback)
   */
  async downloadYouTubeViaLoader(url, tag, quality, isAudioOnly) {
    try {
      // Extract video ID
      const videoId = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/)?.[1];
      if (!videoId) {
        throw new Error('Invalid YouTube URL');
      }

      // Request download
      const formatType = isAudioOnly ? 'audio' : 'video';
      const formatQuality = isAudioOnly ? 'mp3' : quality;

      const prepareResponse = await axios.get(`https://loader.to/ajax/download.php`, {
        params: {
          format: formatType,
          url: url,
          api: 'dfcb6d76f2f6a9894gjkege8a4ab232222'
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 30000
      });

      if (!prepareResponse.data || !prepareResponse.data.id) {
        throw new Error('loader.to prepare failed');
      }

      const downloadId = prepareResponse.data.id;

      // Wait for conversion (poll for status)
      let downloadUrl = null;
      let attempts = 0;
      const maxAttempts = 20;

      while (!downloadUrl && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds

        const progressResponse = await axios.get(`https://loader.to/ajax/progress.php`, {
          params: {
            id: downloadId
          },
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 10000
        });

        if (progressResponse.data && progressResponse.data.download_url) {
          downloadUrl = progressResponse.data.download_url;
          break;
        }

        if (progressResponse.data && progressResponse.data.progress >= 1000) {
          // Conversion complete but no URL (error)
          throw new Error('loader.to conversion failed');
        }

        attempts++;
      }

      if (!downloadUrl) {
        throw new Error('loader.to timeout waiting for conversion');
      }

      // Get title
      const title = prepareResponse.data.title || 'video';

      // Download the file
      const dateTag = getDateTag();
      const ext = isAudioOnly ? 'mp3' : 'mp4';
      const fileName = `${sanitizeFilename(title)}_${dateTag}_${tag}.${ext}`;
      const outPath = path.join(this.tempDir, fileName);

      await this.ensureTempDir();

      logger.info(`[${tag}] Downloading from loader.to: ${fileName}`);

      const writer = fsSync.createWriteStream(outPath);
      const videoResponse = await axios({
        url: downloadUrl,
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
        throw new Error('Download failed - file not created');
      }

      const stats = fsSync.statSync(outPath);
      if (stats.size === 0) {
        throw new Error('Download failed - empty file');
      }

      return {
        path: outPath,
        size: stats.size,
        filename: fileName,
        platform: 'youtube',
        metadata: {
          uploader: 'youtube',
          caption: null,
          resolution: isAudioOnly ? 'audio' : quality + 'p'
        }
      };

    } catch (error) {
      throw new Error(`loader.to: ${error.message}`);
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
