# Migration Guide: v3.0 → v3.1 (Refactored)

## Quick Migration (Minimal Changes)

1. **Copy your existing `.env` file** - It's 100% compatible
2. **Copy any cookie files** to the new `cookies/` directory
3. **Update file paths in package.json**:
   - Change `"main": "bot.js"` → `"main": "src/bot.js"`
   - Update start scripts to point to `src/bot.js`

## File Structure Changes

### Old Structure:
```
project/
├── bot.js
├── tiktok.js
├── logger.js
├── package.json
└── .env
```

### New Structure:
```
project/
├── src/
│   ├── bot.js
│   ├── config/index.js
│   ├── constants/index.js
│   ├── services/
│   │   ├── downloadManager.js
│   │   ├── videoDownloader.js
│   │   └── uploadService.js
│   └── utils/
│       ├── logger.js
│       └── helpers.js
├── cookies/
│   ├── tiktok_cookies.txt
│   └── instagram_cookies.txt
├── logs/
├── package.json
└── .env
```

## Module Mapping

### Old → New Module Locations:

| Old Module | Functionality | New Module |
|------------|--------------|------------|
| `tiktok.js` | Video downloading | `services/videoDownloader.js` |
| `tiktok.js` | File cleanup | `services/videoDownloader.js` |
| `tiktok.js` | Platform detection | `utils/helpers.js` |
| `bot.js` | Queue management | `services/downloadManager.js` |
| `bot.js` | Upload logic | `services/uploadService.js` |
| `bot.js` | Helper functions | `utils/helpers.js` |
| `logger.js` | Logging | `utils/logger.js` (enhanced) |

## Configuration Changes

### Old (inline in bot.js):
```javascript
const CONFIG = {
  LIMIT_BYTES: 8 * 1024 * 1024,
  MAX_CONCURRENT: parseInt(process.env.MAX_CONCURRENT) || 5,
  // ...
};
```

### New (centralized):
```javascript
// src/config/index.js
const CONFIG = {
  DISCORD: {
    LIMIT_BYTES: ...,
    TOKEN: ...,
  },
  DOWNLOAD: {
    MAX_CONCURRENT: ...,
    // ...
  },
  // ...
};
```

## API Changes

### Download Function
**Old:**
```javascript
const result = await tiktok.downloadVideo(url, {
  tag,
  retries: CONFIG.MAX_RETRIES,
  onProgress: (progress) => updateProgress(message, progress)
});
```

**New (identical API):**
```javascript
const result = await videoDownloader.downloadVideo(url, {
  tag,
  retries: CONFIG.DOWNLOAD.MAX_RETRIES,
  onProgress: (progress) => updateProgress(message, progress)
});
```

### Queue Management
**Old:**
```javascript
addToQueue(url, message, platform);
```

**New:**
```javascript
downloadManager.addToQueue({
  url,
  message,
  platform,
  userId: message.author.id,
  channelId: message.channel.id,
  guildId: message.guild?.id
});
```

## Cookie File Location

**Old:** Same directory as bot.js
```
tiktok_cookies.txt
instagram_cookies.txt
```

**New:** Dedicated cookies directory
```
cookies/tiktok_cookies.txt
cookies/instagram_cookies.txt
```

## Environment Variables

No changes needed! All environment variables remain the same:
- `TOKEN`
- `ADMIN_WEBHOOK_URL`
- `MAX_CONCURRENT`
- `MAX_QUEUE_SIZE`
- `MAX_RETRIES`
- `AUTO_UPDATE_DAY`
- `AUTO_UPDATE_HOUR`
- `DISK_WARNING_THRESHOLD`
- `LOG_LEVEL`
- `MAX_FILE_SIZE_MB`
- `RAPIDAPI_KEY`

## Breaking Changes

None! The refactored version maintains 100% feature parity with v3.0.

## New Features in v3.1

1. **Better Error Recovery**: Smarter retry logic with exponential backoff
2. **Memory Management**: Automatic garbage collection when memory usage is high
3. **Structured Logging**: JSON-formatted logs with metadata
4. **Event-Driven Architecture**: Better separation of concerns
5. **Progress Throttling**: Reduced Discord API calls
6. **Graceful Shutdown**: Proper cleanup on exit

## Testing Your Migration

Run this test script to verify everything works:

```javascript
// test-migration.js
require('dotenv').config();
const { CONFIG, validateConfig } = require('./src/config');
const videoDownloader = require('./src/services/videoDownloader');

async function test() {
  console.log('Testing configuration...');
  validateConfig();
  console.log('✅ Configuration valid');
  
  console.log('Testing yt-dlp...');
  const hasYtDlp = await videoDownloader.checkYtDlp();
  console.log(hasYtDlp ? '✅ yt-dlp found' : '❌ yt-dlp not found');
  
  console.log('Testing Discord token...');
  console.log(CONFIG.DISCORD.TOKEN ? '✅ Token configured' : '❌ Token missing');
  
  console.log('\nMigration test complete!');
}

test().catch(console.error);
```

## Rollback Plan

If you need to rollback:
1. Keep your old files as backup
2. The `.env` file works with both versions
3. Cookie files are compatible
4. No database changes to worry about

## Support

If you encounter issues during migration:
1. Check the logs in `logs/error.log`
2. Verify all files are in the correct directories
3. Ensure Node.js version is 16.0.0 or higher
4. Run the test script above
