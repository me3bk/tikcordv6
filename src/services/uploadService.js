// services/uploadService.js - Handle uploads to Discord and file hosts
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { EmbedBuilder } = require('discord.js');
const { CONFIG } = require('../config');
const { FILE_HOSTS, EMOJIS } = require('../constants');
const logger = require('../utils/logger');
const { formatBytes, getQualityBadge, promiseTimeout, shortenText } = require('../utils/helpers');

class UploadService {
  constructor() {
    this.uploadAttempts = new Map();
  }

  /**
   * Upload video to Discord or file host
   * @param {Object} message - Discord message object
   * @param {string} filePath - Path to file
   * @param {number} fileSize - File size in bytes
   * @param {Object} metadata - File metadata
   */
  async uploadToDiscord(message, filePath, fileSize, metadata) {
    const filename = path.basename(filePath);
    const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
    
    try {
      if (fileSize > CONFIG.DISCORD.LIMIT_BYTES) {
        // File too large for Discord, use file host
        await this.uploadToFileHost(message, filePath, filename, fileSize, metadata);
      } else {
        // Direct Discord upload
        await this.uploadDirectToDiscord(message, filePath, filename, fileSize, metadata);
      }
    } catch (error) {
      logger.error(`[${metadata.tag}] Upload failed:`, { error: error.message });
      await this.sendErrorMessage(message, error, sizeMB);
    }
  }

  /**
   * Get quality emoji based on resolution
   * @param {string} resolution - Resolution string
   * @returns {string} Quality emoji
   */
  getQualityEmoji(resolution) {
    if (!resolution || resolution === 'Unknown') {
      return '📹';
    }
    
    const resMatch = resolution.match(/(\d+)x(\d+)/);
    if (!resMatch) {
      return '📹';
    }
    
    const height = parseInt(resMatch[2], 10);
    
    if (height >= 2160) return '🎬'; // 4K
    if (height >= 1080) return '🎞️'; // 1080p
    if (height >= 720) return '📹';  // 720p
    if (height >= 480) return '📱';  // 480p
    return '📹'; // SD
  }

  /**
   * Format resolution for display
   * @param {string} resolution - Resolution string
   * @returns {string} Formatted resolution
   */
  formatResolution(resolution) {
    if (!resolution || resolution === 'Unknown') {
      return 'HD';
    }
    
    const resMatch = resolution.match(/(\d+)x(\d+)/);
    if (!resMatch) {
      return resolution;
    }
    
    const height = parseInt(resMatch[2], 10);
    
    if (height >= 2160) return '4K';
    if (height >= 1080) return '1080p';
    if (height >= 720) return '720p';
    if (height >= 480) return '480p';
    return `${height}p`;
  }

  /**
   * Upload directly to Discord
   * @param {Object} message - Discord message object
   * @param {string} filePath - Path to file
   * @param {string} filename - Filename
   * @param {number} fileSize - File size in bytes
   * @param {Object} metadata - File metadata
   */
  async uploadDirectToDiscord(message, filePath, filename, fileSize, metadata) {
    const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
    const resolution = metadata.resolution || 'Unknown';
    const caption = metadata.caption || null;
    const uploader = metadata.uploader || null;
    const authorId = metadata.authorId;
    
    logger.info(`[${metadata.tag}] Uploading to Discord: ${filename} (${sizeMB}MB)`);
    
    // Build message content with improved format
    let messageContent = '';
    
    // Add caption first if available (bold)
    if (caption && caption.trim().length > 0) {
      const formattedCaption = shortenText(caption, 500);

      // Make caption bold
      messageContent = `**${formattedCaption}**\n\n`;
    }
    
    // Add video info in single line with better format
    const qualityEmoji = this.getQualityEmoji(resolution);
    const formattedRes = this.formatResolution(resolution);
    
    // Format: 🎞️ 1080p • 📦 41.2 MB • 👤 @tiktokuser
    messageContent += `${qualityEmoji} ${formattedRes} • 📦 ${sizeMB} MB`;
    
    // Add TikTok username if available (not the Discord user who triggered)
    if (uploader && uploader !== 'unknown_user' && uploader !== 'Unknown') {
      messageContent += ` • 👤 @${uploader}`;
    }

    // Upload to Discord
    await message.edit({
      content: messageContent,
      embeds: [],
      files: [{
        attachment: filePath,
        name: filename
      }]
    });
    
    logger.info(`[${metadata.tag}] Sent to Discord: ${filename} (${sizeMB}MB)`);
  }

  /**
   * Upload to file hosting service
   * @param {Object} message - Discord message object
   * @param {string} filePath - Path to file
   * @param {string} filename - Filename
   * @param {number} fileSize - File size in bytes
   * @param {Object} metadata - File metadata
   */
  async uploadToFileHost(message, filePath, filename, fileSize, metadata) {
    const sizeMB = (fileSize / 1024 / 1024).toFixed(1);

    logger.info(`[${metadata.tag}] File too large (${sizeMB}MB), uploading to file host...`);

    try {
      // Try 0x0.st first (512MB limit)
      let provider = '0x0.st';
      let uploadUrl = await this.uploadToZeroZeroEst(filePath, filename, fileSize, metadata);

      if (!uploadUrl) {
        provider = 'tmpfiles.org';
        uploadUrl = await this.uploadToTmpfiles(filePath, filename, fileSize, metadata);
      }

      if (!uploadUrl) {
        provider = 'Catbox.moe';
        uploadUrl = await this.uploadToCatbox(filePath, filename, fileSize, metadata);
      }

      if (!uploadUrl) {
        throw new Error('All file host uploads failed');
      }

      // Send link to Discord
      await this.sendFileHostLink(message, uploadUrl, sizeMB, metadata, provider);

    } catch (error) {
      logger.error(`[${metadata.tag}] File host upload failed:`, { error: error.message });
      throw error;
    }
  }

  /**
   * Upload to 0x0.st
   * @param {string} filePath - Path to file
   * @param {string} filename - Filename
   * @param {number} fileSize - File size in bytes
   * @param {Object} metadata - File metadata
   * @returns {string|null} Upload URL or null
   */
  async uploadToZeroZeroEst(filePath, filename, fileSize, metadata) {
    // Check file size limit
    if (fileSize > FILE_HOSTS.ZEROZEROEST.maxSize) {
      logger.warn(`[${metadata.tag}] File too large for 0x0.st (${formatBytes(fileSize)} > 512MB)`);
      return null;
    }

    try {
      logger.info(`[${metadata.tag}] Uploading to 0x0.st...`);

      const form = new FormData();
      form.append('file', fsSync.createReadStream(filePath), {
        filename: filename,
        contentType: 'video/mp4'
      });

      const response = await promiseTimeout(
        axios.post(FILE_HOSTS.ZEROZEROEST.uploadUrl, form, {
          headers: {
            ...form.getHeaders()
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        }),
        300000,
        '0x0.st upload timed out'
      );

      if (response.data && response.data.trim().startsWith('https://')) {
        const downloadUrl = response.data.trim();
        logger.info(`[${metadata.tag}] ✅ 0x0.st upload successful: ${downloadUrl}`);
        return downloadUrl;
      }

      throw new Error('0x0.st returned invalid response');

    } catch (error) {
      logger.warn(`[${metadata.tag}] 0x0.st upload failed:`, { error: error.message });
      return null;
    }
  }

  /**
   * Upload to tmpfiles.org
   * @param {string} filePath - Path to file
   * @param {string} filename - Filename
   * @param {number} fileSize - File size in bytes
   * @param {Object} metadata - File metadata
   * @returns {string|null} Upload URL or null
   */
  async uploadToTmpfiles(filePath, filename, fileSize, metadata) {
    // Check file size limit
    if (fileSize > FILE_HOSTS.TMPFILES.maxSize) {
      logger.warn(`[${metadata.tag}] File too large for tmpfiles.org (${formatBytes(fileSize)} > 100MB)`);
      return null;
    }

    try {
      logger.info(`[${metadata.tag}] Uploading to tmpfiles.org...`);

      const form = new FormData();
      form.append('file', fsSync.createReadStream(filePath), {
        filename: filename,
        contentType: 'video/mp4'
      });

      const response = await promiseTimeout(
        axios.post(FILE_HOSTS.TMPFILES.uploadUrl, form, {
          headers: {
            ...form.getHeaders()
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        }),
        300000,
        'tmpfiles.org upload timed out'
      );

      if (response.data && response.data.data && response.data.data.url) {
        // tmpfiles.org returns URL in format: tmpfiles.org/dl/xxxxx
        // We need to convert it to direct download link
        const downloadUrl = response.data.data.url.replace('/dl/', '/');
        logger.info(`[${metadata.tag}] ✅ tmpfiles.org upload successful: ${downloadUrl}`);
        return downloadUrl;
      }

      throw new Error('tmpfiles.org returned invalid response');

    } catch (error) {
      logger.warn(`[${metadata.tag}] tmpfiles.org upload failed:`, { error: error.message });
      return null;
    }
  }

  /**
   * Upload to Catbox.moe
   * @param {string} filePath - Path to file
   * @param {string} filename - Filename
   * @param {number} fileSize - File size in bytes
   * @param {Object} metadata - File metadata
   * @returns {string|null} Upload URL or null
   */
  async uploadToCatbox(filePath, filename, fileSize, metadata) {
    // Check file size limit
    if (fileSize > FILE_HOSTS.CATBOX.maxSize) {
      logger.warn(`[${metadata.tag}] File too large for Catbox (${formatBytes(fileSize)} > 200MB)`);
      return null;
    }
    
    try {
      logger.info(`[${metadata.tag}] Uploading to Catbox.moe (fallback)...`);
      
      const form = new FormData();
      form.append('reqtype', 'fileupload');
      form.append('fileToUpload', fsSync.createReadStream(filePath), {
        filename: filename,
        contentType: 'video/mp4'
      });
      
      const response = await promiseTimeout(
        axios.post(FILE_HOSTS.CATBOX.uploadUrl, form, {
          headers: {
            ...form.getHeaders()
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        }),
        300000,
        'Catbox upload timed out'
      );
      
      if (response.data && response.data.startsWith('https://')) {
        const downloadUrl = response.data.trim();
        logger.info(`[${metadata.tag}] ✅ Catbox upload successful: ${downloadUrl}`);
        return downloadUrl;
      }
      
      throw new Error('Catbox returned invalid response');
      
    } catch (error) {
      logger.warn(`[${metadata.tag}] Catbox upload failed:`, { error: error.message });
      return null;
    }
  }

  /**
   * Send file host link to Discord
   * @param {Object} message - Discord message object
   * @param {string} uploadUrl - Upload URL
   * @param {string} sizeMB - File size in MB
   * @param {Object} metadata - File metadata
   */
  async sendFileHostLink(message, uploadUrl, sizeMB, metadata, provider = 'File Host') {
    const resolution = metadata.resolution || 'Unknown';
    const caption = metadata.caption || null;
    const uploader = metadata.uploader || null;
    const authorId = metadata.authorId;
    
    let messageContent = '';
    
    // Add caption at the top if available (bold)
    if (caption && caption.trim().length > 0) {
      const formattedCaption = shortenText(caption, 500);
      messageContent = `**${formattedCaption}**\n\n`;
    }
    
    // Add file info
    const qualityEmoji = this.getQualityEmoji(resolution);
    const formattedRes = this.formatResolution(resolution);
    
    messageContent += `${qualityEmoji} ${formattedRes} • 📦 ${sizeMB} MB`;
    
    // Add TikTok username if available
    if (uploader && uploader !== 'unknown_user' && uploader !== 'Unknown') {
      messageContent += ` • 👤 @${uploader}`;
    }

    messageContent += `\n\n⚠️ **File too large for Discord**\n`;
    messageContent += `📦 **Host:** ${provider}\n`;
    messageContent += `📥 **Download:** ${uploadUrl}`;
    
    await message.edit({
      content: messageContent,
      embeds: []
    });
    
    logger.info(`[${metadata.tag}] Sent file host link: ${uploadUrl}`);
  }

  /**
   * Send error message
   * @param {Object} message - Discord message object
   * @param {Error} error - Error object
   * @param {string} sizeMB - File size in MB
   */
  async sendErrorMessage(message, error, sizeMB) {
    const errorEmbed = new EmbedBuilder()
      .setColor(0xE74C3C)
      .setTitle(`${EMOJIS.error} Upload Failed`)
      .setDescription(`File size: ${sizeMB}MB\n\n**Error:** ${error.message}`)
      .setFooter({ text: 'Please try again later' })
      .setTimestamp();
    
    await message.edit({ embeds: [errorEmbed] }).catch(() => {});
  }

  /**
   * Send admin notification
   * @param {string} content - Notification content
   */
  async sendAdminNotification(content) {
    if (!CONFIG.DISCORD.ADMIN_WEBHOOK_URL) return;
    
    try {
      await axios.post(CONFIG.DISCORD.ADMIN_WEBHOOK_URL, {
        content: content,
        username: 'TikCord Monitor'
      });
    } catch (error) {
      logger.error('Failed to send admin notification:', { error: error.message });
    }
  }
}

// Create singleton instance
const uploadService = new UploadService();

module.exports = uploadService;
