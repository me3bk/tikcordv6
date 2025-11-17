// services/downloadManager.js - Centralized download management
const EventEmitter = require('events');
const { CONFIG } = require('../config');
const logger = require('../utils/logger');
const persistenceService = require('./persistenceService');

class DownloadManager extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.activeDownloads = new Map();
    this.queueProcessor = Promise.resolve();
    this.isProcessing = false;
    this.stats = this.initializeStats();
    this.pausedForRecovery = false;
    this.persistenceEnabled = persistenceService.isReady();
    this.bootstrapFromPersistence();
    
    // Set max listeners to prevent warnings
    this.setMaxListeners(CONFIG.DOWNLOAD.MAX_CONCURRENT + 10);
  }

  initializeStats() {
    return {
      totalDownloads: 0,
      successfulDownloads: 0,
      failedDownloads: 0,
      totalBytes: 0,
      byPlatform: {},
      startTime: Date.now(),
      lastYtDlpUpdate: null
    };
  }

  bootstrapFromPersistence() {
    if (!this.persistenceEnabled) {
      return;
    }

    try {
      const pendingItems = persistenceService.loadPendingItems();
      const filteredItems = pendingItems.filter(item => item.retryCount < CONFIG.DOWNLOAD.MAX_RETRIES);
      const dropped = pendingItems.length - filteredItems.length;
      
      if (filteredItems.length > 0) {
        this.queue.push(...filteredItems);
        this.pausedForRecovery = true;
        logger.info(`Loaded ${filteredItems.length} queued download(s) from persistence`);
      }
      
      if (dropped > 0) {
        logger.warn(`Dropped ${dropped} persisted download(s) that exceeded retry limit`);
      }

      const summary = persistenceService.getStatsSummary();
      this.stats.totalDownloads = summary.totalDownloads;
      this.stats.successfulDownloads = summary.successfulDownloads;
      this.stats.failedDownloads = summary.failedDownloads;
      this.stats.totalBytes = summary.totalBytes;
      this.stats.byPlatform = summary.byPlatform;
    } catch (error) {
      logger.error('Failed to bootstrap persistence state:', { error: error.message });
    }
  }

  async resumeFromPersistence(client) {
    if (!this.pausedForRecovery) {
      return;
    }

    await this.rehydrateMessages(client);
    this.pausedForRecovery = false;
    this.processQueue();
  }

  async rehydrateMessages(client) {
    const unresolved = this.queue.filter(
      (item) => !item.message && item.channelId && item.messageId
    );

    for (const item of unresolved) {
      try {
        const channel = await client.channels.fetch(item.channelId);
        if (!channel) throw new Error('Channel not found');
        const message = await channel.messages.fetch(item.messageId);
        item.message = message;
      } catch (error) {
        logger.warn(`[${item.tag}] Unable to rehydrate status message: ${error.message}`);
        this.queue = this.queue.filter((entry) => entry.tag !== item.tag);
        if (this.persistenceEnabled) {
          persistenceService.markFailed(item.tag, 'Status message missing after restart');
        }
      }
    }
  }

  /**
   * Add a download to the queue
   * @param {Object} downloadInfo - Download information
   * @returns {boolean} Whether the download was added
   */
  addToQueue(downloadInfo) {
    if (this.queue.length >= CONFIG.DOWNLOAD.MAX_QUEUE_SIZE) {
      logger.warn('Queue is full, rejecting new download');
      return false;
    }

    const tag = this.generateTag();
    const messageId = downloadInfo.message?.id || downloadInfo.messageId || null;
    const queueItem = {
      ...downloadInfo,
      tag,
      addedAt: Date.now(),
      status: 'queued',
      retryCount: 0,
      authorId: downloadInfo.authorId, // Ensure authorId is preserved
      messageId
    };

    this.queue.push(queueItem);
    logger.info(`[${tag}] Added to queue (${this.queue.length}/${CONFIG.DOWNLOAD.MAX_QUEUE_SIZE})`);

    if (this.persistenceEnabled) {
      persistenceService.saveQueueItem(queueItem);
    }
    
    this.emit('queue:added', queueItem);
    this.processQueue();
    
    return true;
  }

  /**
   * Process the download queue
   */
  async processQueue() {
    if (this.pausedForRecovery || this.isProcessing) return;
    
    this.isProcessing = true;
    
    this.queueProcessor = this.queueProcessor
      .then(async () => {
        while (this.queue.length > 0 && this.activeDownloads.size < CONFIG.DOWNLOAD.MAX_CONCURRENT) {
          const item = this.queue.shift();
          if (item) {
            this.startDownload(item);
          }
        }
      })
      .catch(err => {
        logger.error('Queue processing error:', { error: err.message });
      })
      .finally(() => {
        this.isProcessing = false;
      });
  }

  /**
   * Start a download
   * @param {Object} item - Queue item to download
   */
  async startDownload(item) {
    const { tag, authorId } = item;

    if (!item.message) {
      logger.warn(`[${tag}] Missing Discord message reference, skipping download`);
      this.stats.failedDownloads++;
      if (!this.stats.byPlatform[item.platform]) {
        this.stats.byPlatform[item.platform] = { total: 0, success: 0, failed: 0 };
      }
      this.stats.byPlatform[item.platform].failed++;
      if (this.persistenceEnabled) {
        persistenceService.markFailed(tag, 'Missing Discord message reference');
      }
      this.processQueue();
      return;
    }
    
    this.activeDownloads.set(tag, {
      ...item,
      startTime: Date.now(),
      status: 'downloading',
      authorId: authorId // Keep authorId in active downloads
    });
    
    if (this.persistenceEnabled) {
      persistenceService.markAsActive(tag);
    }

    this.emit('download:start', item);
    
    try {
      // Update stats
      this.stats.totalDownloads++;
      if (!this.stats.byPlatform[item.platform]) {
        this.stats.byPlatform[item.platform] = { total: 0, success: 0, failed: 0 };
      }
      this.stats.byPlatform[item.platform].total++;

      // The actual download will be handled by the video downloader
      // Pass all item data including authorId
      this.emit('download:process', item);
      
    } catch (error) {
      logger.error(`[${tag}] Download failed:`, { error: error.message });
      this.handleDownloadError(item, error);
    }
  }

  /**
   * Complete a download
   * @param {string} tag - Download tag
   * @param {Object} result - Download result
   */
  completeDownload(tag, result) {
    const download = this.activeDownloads.get(tag);
    if (!download) return;

    this.stats.successfulDownloads++;
    this.stats.totalBytes += result.size || 0;
    if (this.stats.byPlatform[download.platform]) {
      this.stats.byPlatform[download.platform].success++;
    }

    if (this.persistenceEnabled) {
      persistenceService.markCompleted(tag, result.size);
    }

    this.activeDownloads.delete(tag);
    this.emit('download:complete', { ...download, result });
    
    logger.info(`[${tag}] Download completed successfully`);
    this.processQueue();
  }

  /**
   * Handle download error
   * @param {Object} item - Download item
   * @param {Error} error - Error that occurred
   */
  handleDownloadError(item, error) {
    const { tag, retryCount = 0, authorId } = item;
    
    // Check if we should retry
    if (retryCount < CONFIG.DOWNLOAD.MAX_RETRIES && this.isRetryableError(error)) {
      item.retryCount = retryCount + 1;
      item.authorId = authorId; // Preserve authorId for retry
      logger.warn(`[${tag}] Retrying download (attempt ${item.retryCount}/${CONFIG.DOWNLOAD.MAX_RETRIES})`);
      
      if (this.persistenceEnabled) {
        persistenceService.updateRetryCount(tag, item.retryCount);
      }
      
      // Re-add to queue with exponential backoff
      setTimeout(() => {
        this.queue.unshift(item);
        this.processQueue();
      }, Math.min(1000 * Math.pow(2, retryCount), 10000));
    } else {
      // Final failure
      this.stats.failedDownloads++;
      if (this.stats.byPlatform[item.platform]) {
        this.stats.byPlatform[item.platform].failed++;
      }
      
      if (this.persistenceEnabled) {
        persistenceService.markFailed(tag, error.message);
      }

      this.activeDownloads.delete(tag);
      this.emit('download:error', { ...item, error });
      
      logger.error(`[${tag}] Download failed permanently:`, { error: error.message });
      this.processQueue();
    }
  }

  /**
   * Check if an error is retryable
   * @param {Error} error - Error to check
   * @returns {boolean} Whether the error is retryable
   */
  isRetryableError(error) {
    if (!error) return true;
    
    if (error.isPermanent) {
      return false;
    }
    
    const sources = [
      error.message?.toLowerCase() || '',
      error.rawOutput?.toLowerCase() || ''
    ].filter(Boolean);
    
    if (sources.length === 0) {
      return true;
    }
    
    const nonRetryablePatterns = [
      'unsupported url',
      'private video',
      'video unavailable',
      'video is unavailable',
      'not available',
      'not found',
      '404',
      '403',
      '410',
      'removed',
      'no longer available',
      'forbidden',
      'suspended',
      'copyright',
      'account is private',
      'user not found',
      'invalid url'
    ];
    
    return !nonRetryablePatterns.some(pattern =>
      sources.some(source => source.includes(pattern))
    );
  }

  /**
   * Generate a unique tag for a download
   * @returns {string} Unique tag
   */
  generateTag() {
    return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get current stats
   * @returns {Object} Current statistics
   */
  getStats() {
    const uptime = (Date.now() - this.stats.startTime) / 1000;
    return {
      ...this.stats,
      uptime,
      queueSize: this.queue.length,
      activeDownloads: this.activeDownloads.size,
      successRate: this.stats.totalDownloads > 0 
        ? (this.stats.successfulDownloads / this.stats.totalDownloads * 100).toFixed(2) + '%'
        : '0%'
    };
  }

  /**
   * Clear the queue
   */
  clearQueue() {
    const cleared = this.queue.length;
    this.queue = [];
    logger.info(`Cleared ${cleared} items from queue`);
    return cleared;
  }

  /**
   * Get queue status
   * @returns {Object} Queue status
   */
  getQueueStatus() {
    return {
      size: this.queue.length,
      maxSize: CONFIG.DOWNLOAD.MAX_QUEUE_SIZE,
      active: this.activeDownloads.size,
      maxConcurrent: CONFIG.DOWNLOAD.MAX_CONCURRENT,
      items: this.queue.map(item => ({
        tag: item.tag,
        url: item.url,
        platform: item.platform,
        addedAt: item.addedAt,
        status: item.status,
        authorId: item.authorId,
        channelId: item.channelId,
        messageId: item.messageId
      }))
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    logger.info('Shutting down download manager...');
    this.pausedForRecovery = true;
    this.queue = [];
    
    // Wait for active downloads to complete (with timeout)
    const shutdownTimeout = setTimeout(() => {
      logger.warn('Forcing shutdown of download manager');
      this.activeDownloads.clear();
    }, 30000);
    
    while (this.activeDownloads.size > 0) {
      logger.info(`Waiting for ${this.activeDownloads.size} active downloads...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    clearTimeout(shutdownTimeout);
    this.removeAllListeners();
    logger.info('Download manager shutdown complete');
  }
}

// Create singleton instance
const downloadManager = new DownloadManager();

module.exports = downloadManager;
