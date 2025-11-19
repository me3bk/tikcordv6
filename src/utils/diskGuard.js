// utils/diskGuard.js - Disk space monitoring for limited storage servers
const { execSync } = require('child_process');
const logger = require('./logger');

class DiskGuard {
  constructor() {
    // Thresholds for 20GB storage
    this.warningThreshold = 80;    // 80% - start warning
    this.criticalThreshold = 90;   // 90% - aggressive cleanup
    this.emergencyThreshold = 95;  // 95% - emergency cleanup

    this.checkInterval = 300000; // Check every 5 minutes
    this.isMonitoring = false;
    this.videoDownloader = null;
  }

  /**
   * Start monitoring disk space
   */
  start(videoDownloader) {
    this.videoDownloader = videoDownloader;

    if (this.isMonitoring) {
      logger.warn('Disk guard already running');
      return;
    }

    this.isMonitoring = true;
    this.interval = setInterval(() => this.check(), this.checkInterval);

    logger.info('💾 Disk Guard started (20GB storage mode)');
    logger.info(`   Warning: ${this.warningThreshold}%`);
    logger.info(`   Critical: ${this.criticalThreshold}%`);
    logger.info(`   Emergency: ${this.emergencyThreshold}%`);

    // Initial check
    this.check();
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.isMonitoring = false;
      logger.info('Disk Guard stopped');
    }
  }

  /**
   * Check current disk usage
   */
  check() {
    try {
      const diskInfo = this.getDiskUsage();

      if (!diskInfo) {
        logger.debug('Could not get disk info');
        return;
      }

      const { usage, available, used, total } = diskInfo;

      // Emergency level
      if (usage >= this.emergencyThreshold) {
        logger.error(`🔴 EMERGENCY: Disk usage critical: ${usage}% (${available} free)`);
        this.emergencyCleanup();
      }
      // Critical level
      else if (usage >= this.criticalThreshold) {
        logger.error(`🔴 CRITICAL: Disk usage very high: ${usage}% (${available} free)`);
        this.criticalCleanup();
      }
      // Warning level
      else if (usage >= this.warningThreshold) {
        logger.warn(`⚠️ WARNING: Disk usage elevated: ${usage}% (${available} free)`);
        this.preventiveCleanup();
      }
      // Normal
      else {
        // Log only every hour
        if (!this.lastNormalLog || Date.now() - this.lastNormalLog > 3600000) {
          logger.debug(`💾 Disk: ${used} / ${total} (${usage}%)`);
          this.lastNormalLog = Date.now();
        }
      }
    } catch (error) {
      logger.debug('Disk check failed:', { error: error.message });
    }
  }

  /**
   * Get disk usage information
   */
  getDiskUsage() {
    try {
      // Get disk info for root partition
      const df = execSync('df -h /').toString();
      const lines = df.split('\n');

      if (lines.length < 2) return null;

      // Parse output
      const parts = lines[1].split(/\s+/);

      // df output: Filesystem Size Used Avail Use% Mounted
      return {
        total: parts[1],
        used: parts[2],
        available: parts[3],
        usage: parseInt(parts[4].replace('%', ''))
      };
    } catch (error) {
      logger.debug('Failed to get disk usage:', { error: error.message });
      return null;
    }
  }

  /**
   * Preventive cleanup - clean files older than 30 minutes
   */
  preventiveCleanup() {
    logger.info('🧹 Preventive disk cleanup (files > 30 min)...');

    if (this.videoDownloader) {
      this.videoDownloader.cleanupOldFiles(0.5); // 30 minutes
    }
  }

  /**
   * Critical cleanup - clean files older than 10 minutes
   */
  criticalCleanup() {
    logger.warn('🧹🧹 Critical disk cleanup (files > 10 min)...');

    if (this.videoDownloader) {
      this.videoDownloader.cleanupOldFiles(10 / 60); // 10 minutes
    }

    // Check after cleanup
    setTimeout(() => {
      const newInfo = this.getDiskUsage();
      if (newInfo && newInfo.usage < this.criticalThreshold) {
        logger.info(`✅ Disk cleanup successful: ${newInfo.usage}%`);
      }
    }, 2000);
  }

  /**
   * Emergency cleanup - delete ALL temp files
   */
  emergencyCleanup() {
    logger.error('🧹🧹🧹 Emergency disk cleanup (deleting ALL temp files)...');

    if (this.videoDownloader) {
      this.videoDownloader.cleanupOldFiles(0); // Delete everything
    }

    // Also try to clear system temp
    try {
      execSync('rm -rf /tmp/yt-dlp-*', { timeout: 5000 });
      logger.info('Cleared system temp files');
    } catch (error) {
      // Ignore errors
    }

    // Check after cleanup
    setTimeout(() => {
      const newInfo = this.getDiskUsage();
      if (newInfo) {
        if (newInfo.usage < this.emergencyThreshold) {
          logger.info(`✅ Emergency cleanup successful: ${newInfo.usage}%`);
        } else {
          logger.error(`🔴 Disk still critical after cleanup: ${newInfo.usage}%`);
        }
      }
    }, 2000);
  }

  /**
   * Get current status
   */
  getStatus() {
    const diskInfo = this.getDiskUsage();

    if (!diskInfo) {
      return { available: false };
    }

    return {
      available: true,
      total: diskInfo.total,
      used: diskInfo.used,
      free: diskInfo.available,
      usage: diskInfo.usage,
      status: this.getStatusLevel(diskInfo.usage)
    };
  }

  /**
   * Get status level
   */
  getStatusLevel(usage) {
    if (usage >= this.emergencyThreshold) return 'emergency';
    if (usage >= this.criticalThreshold) return 'critical';
    if (usage >= this.warningThreshold) return 'warning';
    return 'normal';
  }
}

// Create singleton instance
const diskGuard = new DiskGuard();

module.exports = diskGuard;
