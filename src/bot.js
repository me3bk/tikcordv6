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
const systemService = require('./services/systemService');
const persistenceService = require('./services/persistenceService');
const youtubeService = require('./services/youtubeService');
const memoryGuard = require('./utils/memoryGuard');
const diskGuard = require('./utils/diskGuard');

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

function isAdminUser(userId) {
  const admins = CONFIG.DISCORD.ADMIN_USER_IDS;
  if (!admins || admins.length === 0) return false;
  return admins.includes(userId);
}

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
  
  if (!message) {
    return;
  }
  
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
    persistenceService.cleanupOldRecords(30);
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

  try {
    if (persistenceService && typeof persistenceService.close === 'function') {
      persistenceService.close();
    }
  } catch (error) {
    logger.error('Error while closing persistence service:', { error: error.message });
  }

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
  
  await downloadManager.resumeFromPersistence(client);
  logger.info('Persistence sync complete');

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

  // Start resource guards for 1GB RAM server
  memoryGuard.start(downloadManager, videoDownloader);
  diskGuard.start(videoDownloader);

  await uploadService.sendAdminNotification(
    `🚀 Bot started successfully\n` +
    `**Version:** 4.0.0 (Optimized)\n` +
    `**Server:** 1GB RAM / 20GB Storage\n` +
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
      // Special handling for YouTube - show quality selection
      if (platform === 'youtube') {
        const tag = downloadManager.generateTag();
        const buttons = youtubeService.createQualityButtons(url, tag);

        const selectionEmbed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('▶️ YouTube - اختر الجودة أو الصيغة')
          .setDescription(
            `🎵 **MP3**: صوت فقط (3-5 MB)\n` +
            `📹 **720p**: جودة عالية HD\n` +
            `🎬 **1080p**: جودة كاملة Full HD\n` +
            `📺 **1440p**: جودة 2K\n` +
            `🎞️ **4K**: أعلى جودة 2160p\n` +
            `⭐ **أفضل جودة**: أفضل ما هو متاح\n\n` +
            `⏱️ *تنتهي الصلاحية بعد دقيقة واحدة*`
          )
          .setTimestamp();

        await message.reply({
          embeds: [selectionEmbed],
          components: buttons
        });

        botState.stopProcessing(url); // Will be re-added when button is clicked
        continue;
      }

      // For other platforms - proceed normally
      const replyEmbed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setDescription(`${getPlatformEmoji(platform)} **Queued for download...**`)
        .setTimestamp();

      const replyMessage = await message.reply({ embeds: [replyEmbed] });

      // Add to download queue
      const added = downloadManager.addToQueue({
        url,
        message: replyMessage,
        messageId: replyMessage.id,
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
  // Handle YouTube quality selection buttons
  if (interaction.isButton()) {
    const selection = youtubeService.parseButtonInteraction(interaction.customId);

    if (!selection) {
      await interaction.reply({
        content: '❌ انتهت صلاحية هذا الاختيار. أرسل الرابط مرة أخرى.',
        ephemeral: true
      });
      return;
    }

    const { tag, url, quality, isAudio } = selection;
    const formatOptions = youtubeService.getFormatOptions(quality);

    await interaction.deferReply();

    try {
      // Create initial status message
      const statusEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setDescription(`▶️ **جاري التحميل:** ${formatOptions.description}...`)
        .setTimestamp();

      const statusMessage = await interaction.followUp({ embeds: [statusEmbed] });

      // Add to queue with YouTube-specific options
      const added = downloadManager.addToQueue({
        url,
        message: statusMessage,
        messageId: statusMessage.id,
        platform: 'youtube',
        userId: interaction.user.id,
        authorId: interaction.user.id,
        channelId: interaction.channel.id,
        guildId: interaction.guild?.id,
        youtubeOptions: {
          quality,
          isAudio,
          formatOptions
        }
      });

      if (!added) {
        const errorEmbed = new EmbedBuilder()
          .setColor(0xE74C3C)
          .setDescription(`${EMOJIS.error} **الطابور ممتلئ. حاول مرة أخرى لاحقاً.**`)
          .setTimestamp();

        await statusMessage.edit({ embeds: [errorEmbed] });
      }

      // Delete selection message
      await interaction.message.delete().catch(() => {});

    } catch (error) {
      logger.error(`YouTube button interaction failed:`, { error: error.message });
      await interaction.followUp({
        content: '❌ حدث خطأ. حاول مرة أخرى.',
        ephemeral: true
      });
    }

    return;
  }

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
        
      case 'system':
        if (!isAdminUser(interaction.user.id)) {
          await interaction.reply({ content: 'Only bot admins can use /system commands.', ephemeral: true });
          return;
        }
        
        await interaction.deferReply({ ephemeral: true });
        const subcommand = interaction.options.getSubcommand();
        
        try {
          switch (subcommand) {
            case 'status': {
              const [systemStatus, stats] = await Promise.all([
                systemService.getSystemStatus(),
                downloadManager.getStats()
              ]);
              
              const disk = systemStatus.disk
                ? `${systemStatus.disk.used}/${systemStatus.disk.size} (${systemStatus.disk.percent})`
                : 'Unavailable';
              
              const statusEmbed = new EmbedBuilder()
                .setColor(0x2ECC71)
                .setTitle('🖥️ System Status')
                .addFields(
                  {
                    name: 'CPU Load',
                    value: `${systemStatus.load1.toFixed(2)} (${systemStatus.cpuCount} cores)`,
                    inline: true
                  },
                  {
                    name: 'Memory',
                    value: `${formatBytes(systemStatus.memUsed)} / ${formatBytes(systemStatus.memTotal)} (${systemStatus.memPercent.toFixed(1)}%)`,
                    inline: true
                  },
                  {
                    name: 'Disk (/)',
                    value: disk,
                    inline: true
                  },
                  {
                    name: 'Uptime',
                    value: formatUptime(systemStatus.uptime),
                    inline: true
                  },
                  {
                    name: 'Queue',
                    value: `${stats.activeDownloads}/${CONFIG.DOWNLOAD.MAX_CONCURRENT} active\n${stats.queueSize}/${CONFIG.DOWNLOAD.MAX_QUEUE_SIZE} queued`,
                    inline: true
                  },
                  {
                    name: 'Downloads',
                    value: `${stats.totalDownloads} total (${stats.successRate} success)`,
                    inline: true
                  }
                )
                .setTimestamp();
              
              await interaction.editReply({ embeds: [statusEmbed] });
              break;
            }
            
            case 'apt-upgrade': {
              try {
                const output = await systemService.runAptUpgrade();
                await interaction.editReply({
                  content: `✅ apt update && upgrade completed:\n\`\`\`${output}\`\`\``
                });
              } catch (error) {
                await interaction.editReply({
                  content: `❌ apt upgrade failed: ${error.message}\n\`\`\`${error.output || 'No output captured'}\`\`\``
                });
              }
              break;
            }
            
            case 'update-yt': {
              try {
                const output = await systemService.updateYtDlpBinary();
                await interaction.editReply({
                  content: `✅ yt-dlp update result:\n\`\`\`${output}\`\`\``
                });
              } catch (error) {
                await interaction.editReply({
                  content: `❌ yt-dlp update failed: ${error.message}`
                });
              }
              break;
            }
            
            case 'reboot': {
              await interaction.editReply({
                content: '♻️ Reboot scheduled in 5 seconds. The bot will disconnect shortly.'
              });
              systemService.scheduleReboot(5000);
              break;
            }
            
            default:
              await interaction.editReply({ content: 'Unknown system command.' });
          }
        } catch (error) {
          logger.error('System command error:', { error: error.message, subcommand });
          await interaction.editReply({ content: `❌ Command failed: ${error.message}` });
        }
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
