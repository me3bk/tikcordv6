// services/downloadManager.js - Centralized download management
const EventEmitter = require('events');
const { CONFIG } = require('../config');
const logger = require('../utils/logger');

class DownloadManager extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.activeDownloads = new Map();
    this.queueProcessor = Promise.resolve();
    this.isProcessing = false;
    this.stats = this.initializeStats();
    
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
    const queueItem = {
      ...downloadInfo,
      tag,
      addedAt: Date.now(),
      status: 'queued',
      retryCount: 0,
      authorId: downloadInfo.authorId // Ensure authorId is preserved
    };

    this.queue.push(queueItem);
    logger.info(`[${tag}] Added to queue (${this.queue.length}/${CONFIG.DOWNLOAD.MAX_QUEUE_SIZE})`);
    
    this.emit('queue:added', queueItem);
    this.processQueue();
    
    return true;
  }

  /**
   * Process the download queue
   */
  async processQueue() {
    if (this.isProcessing) return;
    
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
    
    this.activeDownloads.set(tag, {
      ...item,
      startTime: Date.now(),
      status: 'downloading',
      authorId: authorId // Keep authorId in active downloads
    });

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
    const nonRetryableErrors = [
      'Unsupported URL',
      'Private video',
      'removed',
      'not available',
      'Invalid URL'
    ];
    
    return !nonRetryableErrors.some(msg => 
      error.message.toLowerCase().includes(msg.toLowerCase())
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
        authorId: item.authorId
      }))
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    logger.info('Shutting down download manager...');
    
    // Clear queue
    this.clearQueue();
    
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
