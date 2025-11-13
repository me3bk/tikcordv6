// utils/logger.js - Enhanced logger with better error handling and rotation
const fs = require('fs');
const path = require('path');

class Logger {
  constructor(options = {}) {
    this.logsDir = options.logsDir || path.join(process.cwd(), 'logs');
    this.maxFileSize = options.maxFileSize || 10 * 1024 * 1024; // 10MB default
    this.logLevel = process.env.LOG_LEVEL || 'info';
    
    this.levels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };
    
    this.initializeLogFiles();
  }

  initializeLogFiles() {
    try {
      if (!fs.existsSync(this.logsDir)) {
        fs.mkdirSync(this.logsDir, { recursive: true });
      }
      
      this.errorLogPath = path.join(this.logsDir, 'error.log');
      this.combinedLogPath = path.join(this.logsDir, 'combined.log');
      
      // Check and rotate if necessary
      this.checkAndRotate(this.errorLogPath);
      this.checkAndRotate(this.combinedLogPath);
    } catch (err) {
      console.error('Failed to initialize log files:', err);
    }
  }

  checkAndRotate(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        if (stats.size > this.maxFileSize) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const rotatedPath = filePath.replace('.log', `-${timestamp}.log`);
          fs.renameSync(filePath, rotatedPath);
        }
      }
    } catch (err) {
      // Silently fail rotation
    }
  }

  formatLog(level, message, metadata = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level: level.toUpperCase(),
      message: typeof message === 'object' ? JSON.stringify(message) : String(message),
      ...metadata
    };
    
    return JSON.stringify(logEntry);
  }

  writeToFile(filePath, message) {
    try {
      // Check rotation before writing
      this.checkAndRotate(filePath);
      fs.appendFileSync(filePath, message + '\n');
    } catch (err) {
      // Ignore write errors to prevent crash
    }
  }

  shouldLog(level) {
    return this.levels[level] >= this.levels[this.logLevel];
  }

  debug(message, metadata = {}) {
    if (this.shouldLog('debug')) {
      const logLine = this.formatLog('debug', message, metadata);
      this.writeToFile(this.combinedLogPath, logLine);
    }
  }

  info(message, metadata = {}) {
    if (this.shouldLog('info')) {
      const logLine = this.formatLog('info', message, metadata);
      console.log(`ℹ️ ${message}`);
      this.writeToFile(this.combinedLogPath, logLine);
    }
  }

  warn(message, metadata = {}) {
    if (this.shouldLog('warn')) {
      const logLine = this.formatLog('warn', message, metadata);
      console.warn(`⚠️ ${message}`);
      this.writeToFile(this.combinedLogPath, logLine);
    }
  }

  error(message, metadata = {}) {
    if (this.shouldLog('error')) {
      const logLine = this.formatLog('error', message, metadata);
      console.error(`❌ ${message}`);
      this.writeToFile(this.errorLogPath, logLine);
      this.writeToFile(this.combinedLogPath, logLine);
    }
  }

  // Special method for structured logging
  log(level, message, metadata = {}) {
    if (this[level]) {
      this[level](message, metadata);
    }
  }
}

// Create singleton instance
const logger = new Logger();

module.exports = logger;
