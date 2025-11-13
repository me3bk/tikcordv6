// bot.js - Main bot application with improved URL deduplication
require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { CONFIG, validateConfig } = require('./config');
const { PLATFORM_PATTERNS, EMOJIS } = require('./constants');
const logger = require('./utils/logger');
const {
  normalizeUrlForComparison,
  detectAllUrls,
  getPlatformEmoji,
  createProgressBar,
  formatUptime,
  formatBytes
} = require('./utils/helpers');
const downloadManager = require('./services/downloadManager');
const videoDownloader = require('./services/videoDownloader');
const uploadService = require('./services/uploadService');

// Validate configuration
try {
  validateConfig();
} catch (error) {
  logger.error('Configuration error:', { error: error.message });
  process.exit(1);
}

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Bot state with improved URL tracking
class BotState {
  constructor() {
    this.isReady = false;
    this.startTime = Date.now();
    this.intervals = new Set();
    this.processingUrls = new Map(); // Track URLs currently being processed
  }

  addInterval(interval) {
    this.intervals.add(interval);
  }

  clearIntervals() {
    this.intervals.forEach(clearInterval);
    this.intervals.clear();
  }

  // Check if URL is currently being processed
  isProcessing(url) {
    const normalized = normalizeUrlForComparison(url);
    const processingTime = this.processingUrls.get(normalized);
    
    if (!processingTime) return false;
    
    const now = Date.now();
    const timeDiff = now - processingTime;
    
    // Remove if older than 10 seconds (stuck download)
    if (timeDiff > 10000) {
      this.processingUrls.delete(normalized);
      return false;
    }
    
    return true;
  }

  // Mark URL as being processed
  startProcessing(url) {
    const normalized = normalizeUrlForComparison(url);
    this.processingUrls.set(normalized, Date.now());
    
    // Auto-cleanup after 30 seconds
    setTimeout(() => {
      this.processingUrls.delete(normalized);
    }, 30000);
  }

  // Mark URL as done processing
  stopProcessing(url) {
    const normalized = normalizeUrlForComparison(url);
    this.processingUrls.delete(normalized);
  }
}

const botState = new BotState();

// ============= Progress Handler =============

async function updateProgress(message, progress, status = 'downloading') {
  try {
    const progressBar = createProgressBar(progress);
    const emoji = status === 'processing' ? EMOJIS.processing : EMOJIS.downloading;
    
    const embed = new EmbedBuilder()
      .setColor(status === 'processing' ? 0xFFA500 : 0x3498DB)
      .setDescription(`${emoji} **${status === 'processing' ? 'Processing' : 'Downloading'}** ${progress}%\n${progressBar}`)
      .setTimestamp();
    
    // Throttle updates to reduce API calls
    if (!message._lastProgressUpdate || progress - message._lastProgressUpdate >= 5 || progress === 100) {
      await message.edit({ embeds: [embed] });
      message._lastProgressUpdate = progress;
    }
  } catch (error) {
    logger.debug('Failed to update progress:', { error: error.message });
  }
}

// ============= Download Event Handlers =============

downloadManager.on('queue:added', (item) => {
  logger.info(`📋 Queue updated: ${item.tag} added (${item.url})`);
});

downloadManager.on('download:start', async (item) => {
  try {
    const initialEmbed = new EmbedBuilder()
      .setColor(0x3498DB)
      .setDescription(`${EMOJIS.downloading} **Starting download...**`)
      .setTimestamp();
    
    await item.message.edit({ embeds: [initialEmbed] });
  } catch (error) {
    logger.error('Failed to update download start:', { error: error.message });
  }
});

downloadManager.on('download:process', async (item) => {
  const { url, message, tag, platform, authorId } = item;
  
  try {
    logger.info(`🎬 Processing download: ${url}`);
    
    // Download the video
    const result = await videoDownloader.downloadVideo(url, {
      tag,
      retries: CONFIG.DOWNLOAD.MAX_RETRIES,
      onProgress: (progress) => updateProgress(message, progress)
    });
    
    // Update progress to processing
    await updateProgress(message, 100, 'processing');
    
    // Upload to Discord or file host with author info
    await uploadService.uploadToDiscord(message, result.path, result.size, {
      tag,
      platform: result.platform,
      resolution: result.metadata?.resolution,
      uploader: result.metadata?.uploader,
      caption: result.metadata?.caption,
      authorId: authorId
    });
    
    // Clean up temporary file
    await videoDownloader.cleanup(result.path);
    
    // Mark URL as done processing
    botState.stopProcessing(url);
    
    // Mark download as complete
    downloadManager.completeDownload(tag, result);
    
  } catch (error) {
    botState.stopProcessing(url);
    downloadManager.handleDownloadError(item, error);
  }
});

downloadManager.on('download:complete', (data) => {
  logger.info(`✅ Download completed: ${data.tag}`);
});

downloadManager.on('download:error', async (data) => {
  const { message, error, url } = data;
  
  logger.error(`❌ Download failed for ${url}: ${error.message}`);
  
  try {
    const errorEmbed = new EmbedBuilder()
      .setColor(0xE74C3C)
      .setTitle(`${EMOJIS.error} Download Failed`)
      .setDescription(`**Error:** ${error.message}`)
      .setFooter({ text: 'Please try again or check if the video is available' })
      .setTimestamp();
    
    await message.edit({ embeds: [errorEmbed] }).catch(() => {});
  } catch (err) {
    logger.error('Failed to send error message:', { error: err.message });
  }
});

// ============= Scheduled Tasks =============

function scheduleYtDlpUpdates() {
  const interval = setInterval(async () => {
    const now = new Date();
    if (now.getDay() === CONFIG.SYSTEM.AUTO_UPDATE_DAY && 
        now.getHours() === CONFIG.SYSTEM.AUTO_UPDATE_HOUR) {
      const updated = await videoDownloader.updateYtDlp();
      if (updated) {
        downloadManager.stats.lastYtDlpUpdate = new Date();
        await uploadService.sendAdminNotification('✅ yt-dlp updated successfully');
      }
    }
  }, 3600000);
  
  botState.addInterval(interval);
  logger.info('📅 Scheduled automatic yt-dlp updates');
}

function scheduleHealthCheck() {
  const interval = setInterval(async () => {
    const memUsage = process.memoryUsage();
    const heapUsedMB = memUsage.heapUsed / 1024 / 1024;
    
    if (heapUsedMB > CONFIG.SYSTEM.MEMORY_LIMIT_MB) {
      logger.warn(`⚠️ High memory usage: ${heapUsedMB.toFixed(2)}MB`);
      
      if (global.gc) {
        logger.info('Running garbage collection...');
        global.gc();
      }
    }
    
    // Clean up old processing URLs
    const now = Date.now();
    for (const [url, time] of botState.processingUrls.entries()) {
      if (now - time > 60000) {
        botState.processingUrls.delete(url);
      }
    }
    
    const stats = downloadManager.getStats();
    logger.debug('System health check', {
      memoryMB: heapUsedMB.toFixed(2),
      activeDownloads: stats.activeDownloads,
      queueSize: stats.queueSize,
      uptime: formatUptime(stats.uptime),
      successRate: stats.successRate,
      processingUrls: botState.processingUrls.size
    });
    
  }, CONFIG.SYSTEM.HEALTH_CHECK_INTERVAL);
  
  botState.addInterval(interval);
  logger.info('💓 Scheduled health monitoring');
}

function scheduleCleanup() {
  const interval = setInterval(async () => {
    await videoDownloader.cleanupOldFiles(24);
  }, CONFIG.SYSTEM.CLEANUP_INTERVAL);
  
  botState.addInterval(interval);
  logger.info('🧹 Scheduled automatic cleanup');
}

// ============= Graceful Shutdown =============

async function gracefulShutdown() {
  logger.warn('🛑 Initiating graceful shutdown...');
  
  botState.clearIntervals();
  await downloadManager.shutdown();
  await client.destroy();
  
  logger.info('✅ Graceful shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection:', { error: error.message, stack: error.stack });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', { error: error.message, stack: error.stack });
});

// ============= Discord Event Handlers =============

client.once('ready', async () => {
  botState.isReady = true;
  logger.info(`✅ Bot logged in as ${client.user.tag}`);
  
  console.log('\n' + '='.repeat(60));
  console.log('🎉 TikCord Reborn - Enhanced Edition v3.2 (Final)');
  console.log('='.repeat(60));
  console.log(`✅ Bot Status: ONLINE`);
  console.log(`👤 Logged in as: ${client.user.tag}`);
  console.log(`🔗 Connected to ${client.guilds.cache.size} server(s)`);
  console.log(`⚙️  Settings:`);
  console.log(`   • Max File Size: ${(CONFIG.DISCORD.LIMIT_BYTES/1024/1024).toFixed(0)}MB`);
  console.log(`   • Max Concurrent: ${CONFIG.DOWNLOAD.MAX_CONCURRENT}`);
  console.log(`   • Queue Size: ${CONFIG.DOWNLOAD.MAX_QUEUE_SIZE}`);
  console.log(`🌐 Supported Platforms:`);
  console.log(`   TikTok, Instagram, YouTube, Twitter, Snapchat, Facebook, Reddit`);
  console.log(`📤 File Hosts: GoFile.io (unlimited) → Catbox.moe (200MB)`);
  console.log('='.repeat(60));
  console.log('✅ Bot is ready and listening for video links...');
  console.log('='.repeat(60) + '\n');
  
  const hasYtDlp = await videoDownloader.checkYtDlp();
  if (hasYtDlp) {
    await videoDownloader.updateYtDlp();
  } else {
    logger.error('yt-dlp not found! Please install yt-dlp to use this bot.');
    await uploadService.sendAdminNotification('⚠️ yt-dlp not found! Bot functionality limited.');
  }
  
  scheduleYtDlpUpdates();
  scheduleHealthCheck();
  scheduleCleanup();
  
  await uploadService.sendAdminNotification(
    `🚀 Bot started successfully\n` +
    `**Version:** 3.2.0 (Final)\n` +
    `**Time:** ${new Date().toLocaleString()}\n` +
    `**yt-dlp:** ${hasYtDlp ? 'Available' : 'Not found'}`
  );
});

client.on('messageCreate', async (message) => {
  // Allow bot messages (as requested - removed bot check)
  
  // Detect all URLs with built-in deduplication
  const detectedUrls = detectAllUrls(message.content, PLATFORM_PATTERNS);
  
  if (detectedUrls.length === 0) {
    return;
  }

  // Log what was detected
  if (detectedUrls.length > 0) {
    logger.info(`🔍 Detected ${detectedUrls.length} unique URL(s) from ${message.author.tag}:`);
    detectedUrls.forEach(({ url, platform }) => {
      logger.info(`  • ${platform}: ${url}`);
    });
  }

  // Filter out URLs that are currently being processed
  const urlsToProcess = [];
  
  for (const { url, platform } of detectedUrls) {
    if (botState.isProcessing(url)) {
      logger.warn(`⏱️ Already processing: ${url}`);
      continue;
    }
    
    urlsToProcess.push({ url, platform });
    botState.startProcessing(url);
  }

  if (urlsToProcess.length === 0) {
    logger.debug('All URLs are already being processed');
    return;
  }

  logger.info(`✨ Processing ${urlsToProcess.length} URL(s)`);

  // Process each unique URL
  for (const { url, platform } of urlsToProcess) {
    try {
      // Create reply for this URL
      const replyEmbed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setDescription(`${getPlatformEmoji(platform)} **Queued for download...**`)
        .setTimestamp();
      
      const replyMessage = await message.reply({ embeds: [replyEmbed] });
      
      // Add to download queue
      const added = downloadManager.addToQueue({
        url,
        message: replyMessage,
        platform,
        userId: message.author.id,
        authorId: message.author.id,
        channelId: message.channel.id,
        guildId: message.guild?.id
      });
      
      if (!added) {
        // Queue is full
        botState.stopProcessing(url);
        
        const errorEmbed = new EmbedBuilder()
          .setColor(0xE74C3C)
          .setDescription(`${EMOJIS.error} **Queue is full. Please try again later.**`)
          .setTimestamp();
        
        await replyMessage.edit({ embeds: [errorEmbed] });
      }
      
    } catch (error) {
      logger.error(`Failed to process URL ${url}:`, { error: error.message });
      botState.stopProcessing(url);
    }
  }
});

client.on('error', (error) => {
  logger.error('Discord client error:', { error: error.message });
});

// ============= Command Handler =============

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;
  
  const { commandName } = interaction;
  
  try {
    switch (commandName) {
      case 'stats':
        const stats = downloadManager.getStats();
        const statsEmbed = new EmbedBuilder()
          .setColor(0x3498DB)
          .setTitle('📊 Bot Statistics')
          .addFields(
            { name: 'Uptime', value: formatUptime(stats.uptime), inline: true },
            { name: 'Total Downloads', value: stats.totalDownloads.toString(), inline: true },
            { name: 'Success Rate', value: stats.successRate, inline: true },
            { name: 'Queue Size', value: `${stats.queueSize}/${CONFIG.DOWNLOAD.MAX_QUEUE_SIZE}`, inline: true },
            { name: 'Active Downloads', value: `${stats.activeDownloads}/${CONFIG.DOWNLOAD.MAX_CONCURRENT}`, inline: true },
            { name: 'Total Data', value: formatBytes(stats.totalBytes), inline: true }
          )
          .setTimestamp();
        
        await interaction.reply({ embeds: [statsEmbed], ephemeral: true });
        break;
        
      case 'queue':
        const queueStatus = downloadManager.getQueueStatus();
        const queueEmbed = new EmbedBuilder()
          .setColor(0x3498DB)
          .setTitle('📋 Download Queue')
          .setDescription(
            `**Active:** ${queueStatus.active}/${queueStatus.maxConcurrent}\n` +
            `**Queued:** ${queueStatus.size}/${queueStatus.maxSize}\n\n` +
            (queueStatus.items.length > 0 
              ? queueStatus.items.slice(0, 5).map((item, i) => 
                  `${i + 1}. ${getPlatformEmoji(item.platform)} ${item.platform}`
                ).join('\n')
              : 'Queue is empty')
          )
          .setTimestamp();
        
        await interaction.reply({ embeds: [queueEmbed], ephemeral: true });
        break;
        
      default:
        await interaction.reply({ content: 'Unknown command', ephemeral: true });
    }
  } catch (error) {
    logger.error('Command error:', { error: error.message, command: commandName });
    await interaction.reply({ 
      content: 'An error occurred while processing your command', 
      ephemeral: true 
    }).catch(() => {});
  }
});

// ============= Start Bot =============

async function startBot() {
  try {
    await client.login(CONFIG.DISCORD.TOKEN);
  } catch (error) {
    logger.error('Failed to login:', { error: error.message });
    process.exit(1);
  }
}

startBot();

module.exports = client;
