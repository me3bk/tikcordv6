// services/youtubeService.js - YouTube-specific features with quality/format selection
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const logger = require('../utils/logger');

class YoutubeService {
  constructor() {
    this.pendingSelections = new Map(); // Store pending user selections
    this.selectionTimeout = 60000; // 1 minute timeout
  }

  /**
   * Create quality selection buttons for YouTube URL
   * @param {string} url - YouTube URL
   * @param {string} tag - Download tag
   * @returns {Object} Components with buttons
   */
  createQualityButtons(url, tag) {
    const row1 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`yt_audio_${tag}`)
          .setLabel('🎵 MP3 صوت فقط')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`yt_720p_${tag}`)
          .setLabel('📹 720p')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`yt_1080p_${tag}`)
          .setLabel('🎬 1080p')
          .setStyle(ButtonStyle.Primary)
      );

    const row2 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`yt_1440p_${tag}`)
          .setLabel('📺 1440p (2K)')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`yt_2160p_${tag}`)
          .setLabel('🎞️ 4K')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`yt_best_${tag}`)
          .setLabel('⭐ أفضل جودة')
          .setStyle(ButtonStyle.Secondary)
      );

    // Store selection info
    this.pendingSelections.set(tag, {
      url,
      createdAt: Date.now()
    });

    // Auto-cleanup after timeout
    setTimeout(() => {
      this.pendingSelections.delete(tag);
    }, this.selectionTimeout);

    return [row1, row2];
  }

  /**
   * Parse button interaction and get download options
   * @param {string} customId - Button custom ID
   * @returns {Object} Download options
   */
  parseButtonInteraction(customId) {
    const parts = customId.split('_');

    if (parts.length < 3 || parts[0] !== 'yt') {
      return null;
    }

    const quality = parts[1];
    const tag = parts.slice(2).join('_');

    const selection = this.pendingSelections.get(tag);

    if (!selection) {
      return null; // Expired or invalid
    }

    // Remove from pending
    this.pendingSelections.delete(tag);

    return {
      tag,
      url: selection.url,
      quality,
      isAudio: quality === 'audio'
    };
  }

  /**
   * Get yt-dlp format string for quality selection
   * @param {string} quality - Quality selection (audio, 720p, 1080p, etc.)
   * @returns {Object} Format options
   */
  getFormatOptions(quality) {
    switch (quality) {
      case 'audio':
        return {
          format: 'bestaudio',
          extractAudio: true,
          audioFormat: 'mp3',
          audioQuality: '192',
          ext: 'mp3',
          description: 'MP3 صوت فقط'
        };

      case '720p':
        return {
          format: 'bestvideo[height<=720]+bestaudio/best[height<=720]',
          ext: 'mp4',
          description: '720p HD'
        };

      case '1080p':
        return {
          format: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
          ext: 'mp4',
          description: '1080p Full HD'
        };

      case '1440p':
        return {
          format: 'bestvideo[height<=1440]+bestaudio/best[height<=1440]',
          ext: 'mp4',
          description: '1440p 2K'
        };

      case '2160p':
        return {
          format: 'bestvideo[height<=2160]+bestaudio/best[height<=2160]',
          ext: 'mp4',
          description: '2160p 4K'
        };

      case 'best':
      default:
        return {
          format: 'bestvideo*+bestaudio/best',
          ext: 'mp4',
          description: 'أفضل جودة متاحة'
        };
    }
  }

  /**
   * Build yt-dlp arguments for YouTube download
   * @param {string} url - YouTube URL
   * @param {string} outputPath - Output file path
   * @param {Object} formatOptions - Format options from getFormatOptions()
   * @returns {Array} yt-dlp arguments
   */
  buildYtDlpArgs(url, outputPath, formatOptions) {
    const baseArgs = [
      url,
      '--format', formatOptions.format,
      '-o', outputPath,
      '--no-warnings',
      '--no-playlist',
      '--socket-timeout', '60',
      '--retries', '10',
      '--fragment-retries', '20',
      '--concurrent-fragments', '32',
      '--buffer-size', '32K',
      '--merge-output-format', formatOptions.ext,
      '--progress',
      '--newline',
      // ✅ Bypass YouTube bot detection
      '--extractor-args', 'youtube:player_client=default,web',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    ];

    // Add audio extraction options if needed
    if (formatOptions.extractAudio) {
      baseArgs.push(
        '--extract-audio',
        '--audio-format', formatOptions.audioFormat,
        '--audio-quality', formatOptions.audioQuality
      );
    }

    return baseArgs;
  }

  /**
   * Clean up expired selections
   */
  cleanupExpired() {
    const now = Date.now();
    let cleaned = 0;

    for (const [tag, selection] of this.pendingSelections.entries()) {
      if (now - selection.createdAt > this.selectionTimeout) {
        this.pendingSelections.delete(tag);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`Cleaned up ${cleaned} expired YouTube selections`);
    }
  }

  /**
   * Get status
   */
  getStatus() {
    return {
      pendingSelections: this.pendingSelections.size,
      timeout: this.selectionTimeout
    };
  }
}

// Create singleton instance
const youtubeService = new YoutubeService();

// Cleanup expired selections every minute
setInterval(() => youtubeService.cleanupExpired(), 60000);

module.exports = youtubeService;
