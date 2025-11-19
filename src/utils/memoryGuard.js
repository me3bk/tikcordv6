// utils/memoryGuard.js - Memory monitoring and protection for low-RAM servers
const logger = require('./logger');

class MemoryGuard {
  constructor() {
    // Thresholds for 1GB RAM server
    this.warningThreshold = 600 * 1024 * 1024;    // 600 MB - start warning
    this.criticalThreshold = 750 * 1024 * 1024;   // 750 MB - aggressive cleanup
    this.emergencyThreshold = 850 * 1024 * 1024;  // 850 MB - emergency restart

    this.checkInterval = 30000; // Check every 30 seconds
    this.isMonitoring = false;
    this.downloadManager = null;
    this.videoDownloader = null;
  }

  /**
   * Start monitoring memory usage
   */
  start(downloadManager, videoDownloader) {
    this.downloadManager = downloadManager;
    this.videoDownloader = videoDownloader;

    if (this.isMonitoring) {
      logger.warn('Memory guard already running');
      return;
    }

    this.isMonitoring = true;
    this.interval = setInterval(() => this.check(), this.checkInterval);

    logger.info('🛡️ Memory Guard started (1GB RAM mode)');
    logger.info(`   Warning: ${this.formatBytes(this.warningThreshold)}`);
    logger.info(`   Critical: ${this.formatBytes(this.criticalThreshold)}`);
    logger.info(`   Emergency: ${this.formatBytes(this.emergencyThreshold)}`);
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.isMonitoring = false;
      logger.info('Memory Guard stopped');
    }
  }

  /**
   * Check current memory usage
   */
  check() {
    const usage = process.memoryUsage();
    const heapUsed = usage.heapUsed;
    const rss = usage.rss; // Resident Set Size (total memory)

    // Emergency level - restart immediately
    if (heapUsed > this.emergencyThreshold) {
      logger.error(`🔴 EMERGENCY: Memory critically high! ${this.formatBytes(heapUsed)} / 1GB`);
      logger.error('🔴 Initiating emergency restart...');

      // Clear everything
      this.emergencyCleanup();

      // Give PM2 3 seconds to save state, then exit
      setTimeout(() => {
        logger.error('🔴 Exiting for PM2 restart...');
        process.exit(1); // PM2 will restart automatically
      }, 3000);

      return;
    }

    // Critical level - aggressive cleanup
    if (heapUsed > this.criticalThreshold) {
      logger.error(`🔴 CRITICAL: Memory usage very high: ${this.formatBytes(heapUsed)} / 1GB`);

      // Aggressive cleanup
      this.criticalCleanup();

      // Force garbage collection
      if (global.gc) {
        logger.warn('Running garbage collection...');
        global.gc();
      }

      // Check if it helped
      setTimeout(() => {
        const newUsage = process.memoryUsage().heapUsed;
        if (newUsage > this.criticalThreshold) {
          logger.error(`🔴 Cleanup didn't help enough. Still at ${this.formatBytes(newUsage)}`);
          logger.error('🔴 Will restart on next check if still high');
        } else {
          logger.info(`✅ Cleanup successful. Now at ${this.formatBytes(newUsage)}`);
        }
      }, 2000);

    } else if (heapUsed > this.warningThreshold) {
      // Warning level - preventive cleanup
      logger.warn(`⚠️ Memory usage elevated: ${this.formatBytes(heapUsed)} / 1GB`);

      this.preventiveCleanup();

      // Gentle GC
      if (global.gc) {
        global.gc();
      }
    }

    // Log normal status every 5 minutes
    if (!this.lastNormalLog || Date.now() - this.lastNormalLog > 300000) {
      logger.debug(`Memory: ${this.formatBytes(heapUsed)} heap, ${this.formatBytes(rss)} total`);
      this.lastNormalLog = Date.now();
    }
  }

  /**
   * Preventive cleanup - light cleanup when memory is elevated
   */
  preventiveCleanup() {
    logger.info('🧹 Preventive cleanup...');

    // Clean old temp files (older than 10 minutes)
    if (this.videoDownloader) {
      this.videoDownloader.cleanupOldFiles(10 / 60); // 10 minutes in hours
    }
  }

  /**
   * Critical cleanup - aggressive cleanup when memory is critical
   */
  criticalCleanup() {
    logger.warn('🧹🧹 Critical cleanup...');

    // Clear entire download queue
    if (this.downloadManager) {
      const cleared = this.downloadManager.clearQueue();
      logger.warn(`Cleared ${cleared} items from download queue`);
    }

    // Delete ALL temp files immediately
    if (this.videoDownloader) {
      this.videoDownloader.cleanupOldFiles(0); // Delete everything
    }
  }

  /**
   * Emergency cleanup - maximum cleanup before restart
   */
  emergencyCleanup() {
    logger.error('🧹🧹🧹 Emergency cleanup...');

    // Stop accepting new downloads
    if (this.downloadManager) {
      this.downloadManager.clearQueue();
      logger.error('Download queue cleared');
    }

    // Delete all temp files
    if (this.videoDownloader) {
      this.videoDownloader.cleanupOldFiles(0);
    }

    // Force GC
    if (global.gc) {
      global.gc();
    }
  }

  /**
   * Format bytes to human readable
   */
  formatBytes(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(0)}MB`;
  }

  /**
   * Get current status
   */
  getStatus() {
    const usage = process.memoryUsage();

    return {
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      rss: usage.rss,
      external: usage.external,
      warningThreshold: this.warningThreshold,
      criticalThreshold: this.criticalThreshold,
      emergencyThreshold: this.emergencyThreshold,
      percentage: (usage.heapUsed / (1024 * 1024 * 1024) * 100).toFixed(1),
      status: this.getStatusLevel(usage.heapUsed)
    };
  }

  /**
   * Get status level
   */
  getStatusLevel(heapUsed) {
    if (heapUsed > this.emergencyThreshold) return 'emergency';
    if (heapUsed > this.criticalThreshold) return 'critical';
    if (heapUsed > this.warningThreshold) return 'warning';
    return 'normal';
  }
}

// Create singleton instance
const memoryGuard = new MemoryGuard();

module.exports = memoryGuard;
