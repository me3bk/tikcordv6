// services/persistenceService.js - SQLite-backed download history & queue
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const logger = require('../utils/logger');
const { CONFIG } = require('../config');

class PersistenceService {
  constructor() {
    this.db = null;
    this.init();
  }

  init() {
    try {
      const dataDir = CONFIG.PATHS.DATA_DIR || path.join(process.cwd(), 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      const dbPath = path.join(dataDir, 'tikcord.db');
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS downloads (
          tag TEXT PRIMARY KEY,
          url TEXT,
          platform TEXT,
          status TEXT,
          user_id TEXT,
          author_id TEXT,
          channel_id TEXT,
          guild_id TEXT,
          message_id TEXT,
          size INTEGER,
          error TEXT,
          added_at INTEGER,
          started_at INTEGER,
          completed_at INTEGER,
          retries INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);
        CREATE INDEX IF NOT EXISTS idx_downloads_platform ON downloads(platform);
      `);
    } catch (error) {
      logger.error('Failed to initialize persistence service:', { error: error.message });
      this.db = null;
    }
  }

  isReady() {
    return Boolean(this.db);
  }

  saveQueueItem(item) {
    if (!this.isReady()) return;

    try {
      const stmt = this.db.prepare(`
        INSERT INTO downloads (
          tag, url, platform, status, user_id, author_id,
          channel_id, guild_id, message_id, added_at, retries
        )
        VALUES (@tag, @url, @platform, @status, @userId, @authorId,
                @channelId, @guildId, @messageId, @addedAt, @retries)
        ON CONFLICT(tag) DO UPDATE SET
          url=excluded.url,
          platform=excluded.platform,
          status=excluded.status,
          user_id=excluded.user_id,
          author_id=excluded.author_id,
          channel_id=excluded.channel_id,
          guild_id=excluded.guild_id,
          message_id=excluded.message_id,
          added_at=excluded.added_at,
          retries=excluded.retries
      `);

      stmt.run({
        tag: item.tag,
        url: item.url,
        platform: item.platform,
        status: item.status || 'queued',
        userId: item.userId || null,
        authorId: item.authorId || null,
        channelId: item.channelId || null,
        guildId: item.guildId || null,
        messageId: item.message?.id || item.messageId || null,
        addedAt: item.addedAt || Date.now(),
        retries: item.retryCount || 0
      });
    } catch (error) {
      logger.error('Failed to save queue item:', {
        error: error.message,
        tag: item.tag,
        url: item.url
      });
    }
  }

  markAsActive(tag) {
    if (!this.isReady()) return;
    this.db.prepare(`
      UPDATE downloads
      SET status='downloading', started_at=@startedAt
      WHERE tag=@tag
    `).run({ tag, startedAt: Date.now() });
  }

  markCompleted(tag, size) {
    if (!this.isReady()) return;
    this.db.prepare(`
      UPDATE downloads
      SET status='completed',
          size=@size,
          error=NULL,
          completed_at=@completedAt
      WHERE tag=@tag
    `).run({ tag, size: size || 0, completedAt: Date.now() });
  }

  markFailed(tag, errorMessage) {
    if (!this.isReady()) return;
    this.db.prepare(`
      UPDATE downloads
      SET status='failed',
          error=@error,
          completed_at=@completedAt
      WHERE tag=@tag
    `).run({
      tag,
      error: errorMessage,
      completedAt: Date.now()
    });
  }

  updateRetryCount(tag, retries) {
    if (!this.isReady()) return;
    this.db.prepare(`
      UPDATE downloads
      SET retries=@retries,
          status='queued'
      WHERE tag=@tag
    `).run({ tag, retries });
  }

  loadPendingItems() {
    if (!this.isReady()) return [];

    const rows = this.db.prepare(`
      SELECT *
      FROM downloads
      WHERE status IN ('queued', 'downloading')
      ORDER BY added_at ASC
    `).all();

    return rows.map((row) => ({
      tag: row.tag,
      url: row.url,
      platform: row.platform,
      status: 'queued',
      addedAt: row.added_at,
      retryCount: row.retries || 0,
      userId: row.user_id,
      authorId: row.author_id,
      channelId: row.channel_id,
      guildId: row.guild_id,
      messageId: row.message_id,
      message: null
    }));
  }

  getStatsSummary() {
    if (!this.isReady()) {
      return {
        totalDownloads: 0,
        successfulDownloads: 0,
        failedDownloads: 0,
        totalBytes: 0,
        byPlatform: {}
      };
    }

    const totals = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status='completed' THEN COALESCE(size, 0) ELSE 0 END) AS bytes
      FROM downloads
    `).get();

    const platformRows = this.db.prepare(`
      SELECT
        platform,
        COUNT(*) AS total,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
      FROM downloads
      GROUP BY platform
    `).all();

    const byPlatform = {};
    for (const row of platformRows) {
      byPlatform[row.platform || 'unknown'] = {
        total: row.total || 0,
        success: row.success || 0,
        failed: row.failed || 0
      };
    }

    return {
      totalDownloads: totals.total || 0,
      successfulDownloads: totals.success || 0,
      failedDownloads: totals.failed || 0,
      totalBytes: totals.bytes || 0,
      byPlatform
    };
  }

  cleanupOldRecords(maxAgeDays = 30) {
    if (!this.isReady()) return;

    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    try {
      const result = this.db.prepare(`
        DELETE FROM downloads
        WHERE completed_at IS NOT NULL
          AND completed_at < @cutoff
      `).run({ cutoff });

      if (result.changes > 0) {
        logger.info(`Cleaned up ${result.changes} old download records (older than ${maxAgeDays} days)`);
      }
    } catch (error) {
      logger.error('Failed to cleanup old records:', { error: error.message });
    }
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch (error) {
        logger.error('Failed to close persistence DB:', { error: error.message });
      } finally {
        this.db = null;
      }
    }
  }
}

module.exports = new PersistenceService();
