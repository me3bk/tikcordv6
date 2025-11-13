# TikCord Reborn - Enhanced Edition v3.1 (Refactored)

Multi-platform Discord bot with maximum quality video downloads.

## 🚀 Major Improvements in v3.1 Refactor

### Architecture & Code Quality
- **Modular Structure**: Separated concerns into distinct modules (config, services, utils, constants)
- **Event-Driven Architecture**: Download manager uses EventEmitter for better decoupling
- **Singleton Pattern**: Services use singleton instances to prevent multiple instantiations
- **Better Error Boundaries**: Each module handles its own errors gracefully

### Performance Optimizations
- **Memory Management**: Added memory monitoring and automatic garbage collection
- **Progress Throttling**: Reduced Discord API calls by throttling progress updates
- **Promise Timeout Wrapper**: Added timeout protection for all async operations
- **Retry with Exponential Backoff**: Smarter retry logic with increasing delays

### Reliability Enhancements
- **Graceful Shutdown**: Proper cleanup of resources and pending downloads
- **Better Error Classification**: Distinguishes between retryable and non-retryable errors
- **File Cleanup**: Automatic cleanup of failed downloads and old files
- **State Management**: Centralized bot state management

### Safety Improvements
- **Input Validation**: Better validation of URLs and parameters
- **Race Condition Prevention**: Queue processor prevents concurrent processing issues
- **Resource Limits**: Memory and timeout limits to prevent resource exhaustion
- **Duplicate URL Detection**: Prevents processing the same URL multiple times

### Code Maintainability
- **Centralized Configuration**: All config in one place with validation
- **Consistent Logging**: Structured logging with metadata
- **Type Safety**: Better parameter validation and error handling
- **Clear Separation**: Business logic separated from Discord interaction

## 📁 Project Structure

```
tikcord-refactored/
├── src/
│   ├── bot.js                 # Main bot application
│   ├── config/
│   │   └── index.js           # Centralized configuration
│   ├── constants/
│   │   └── index.js           # Application constants
│   ├── services/
│   │   ├── downloadManager.js # Download queue management
│   │   ├── videoDownloader.js # Video download logic
│   │   └── uploadService.js   # Upload handling
│   └── utils/
│       ├── logger.js          # Enhanced logging
│       └── helpers.js         # Utility functions
├── cookies/                   # Cookie files (optional)
├── logs/                      # Log files
├── package.json
├── .env.example
└── README.md
```

## 🛠️ Installation

### Prerequisites
- Node.js 16.0.0 or higher
- yt-dlp installed globally
- Discord Bot Token
- FFmpeg (for yt-dlp)

### Setup Steps

1. **Clone and install dependencies**
```bash
npm install
```

2. **Install yt-dlp**
```bash
# Windows
winget install yt-dlp

# macOS
brew install yt-dlp

# Linux
sudo wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

3. **Configure environment**
```bash
cp .env.example .env
# Edit .env with your Discord token
```

4. **Optional: Add cookies for better success rates**
Create `cookies/` directory and add:
- `tiktok_cookies.txt` - TikTok cookies in Netscape format
- `instagram_cookies.txt` - Instagram cookies in Netscape format

5. **Run the bot**
```bash
npm start
# or for development with garbage collection
npm run start:dev
```

## 🌟 Features

### Supported Platforms
- ✅ TikTok (with API fallback)
- ✅ Instagram (with RapidAPI fallback)
- ✅ YouTube/YouTube Shorts
- ✅ Twitter/X
- ✅ Snapchat
- ✅ Facebook
- ✅ Reddit

### Key Features
- **Maximum Quality Downloads**: Platform-specific format selection
- **Smart Queue Management**: Concurrent download limiting
- **Progress Tracking**: Real-time download progress
- **File Host Integration**: Automatic upload to GoFile/Catbox for large files
- **Automatic Updates**: Scheduled yt-dlp updates
- **Memory Management**: Automatic garbage collection
- **Error Recovery**: Smart retry logic with fallback methods
- **Admin Monitoring**: Webhook notifications for important events

## 🔧 Configuration

### Environment Variables
- `TOKEN`: Discord bot token (required)
- `ADMIN_WEBHOOK_URL`: Discord webhook for notifications
- `MAX_CONCURRENT`: Maximum concurrent downloads (default: 5)
- `MAX_QUEUE_SIZE`: Maximum queue size (default: 50)
- `MAX_RETRIES`: Retry attempts per download (default: 3)
- `RAPIDAPI_KEY`: For Instagram fallback API

## 📈 Future Improvements

### Short-term (Next Update)
1. **Database Integration**: SQLite/PostgreSQL for download history and statistics
2. **User Preferences**: Per-user quality preferences and download limits
3. **Command System**: Slash commands for stats, queue management, and settings
4. **Rate Limiting**: Per-user and per-server rate limits
5. **Webhook Queue**: Separate webhook for large file notifications

### Medium-term
1. **Clustering**: Multi-process support for high-load scenarios
2. **Redis Cache**: Cache video metadata and download URLs
3. **Advanced Analytics**: Detailed statistics and usage reports
4. **Plugin System**: Extensible architecture for custom platforms
5. **Web Dashboard**: Admin panel for monitoring and configuration

### Long-term
1. **Distributed Architecture**: Multiple bot instances with load balancing
2. **AI Enhancement**: Smart quality selection based on content type
3. **P2P Distribution**: Torrent-based distribution for popular videos
4. **Transcoding**: On-the-fly video conversion and compression
5. **CDN Integration**: CloudFlare/AWS S3 for permanent storage

## 🐛 Debugging

### Common Issues

1. **yt-dlp not found**
   - Ensure yt-dlp is in PATH
   - Run `yt-dlp --version` to verify

2. **Download failures**
   - Check if cookies are valid
   - Verify yt-dlp is up to date
   - Check platform-specific issues

3. **Memory issues**
   - Run with `--expose-gc` flag
   - Reduce MAX_CONCURRENT setting
   - Monitor with `npm run start:dev`

### Log Files
- `logs/combined.log`: All logs
- `logs/error.log`: Error logs only

## 📝 License

MIT License - See LICENSE file for details

## 🤝 Contributing

Contributions are welcome! Please ensure:
1. Code follows the modular structure
2. All functions have JSDoc comments
3. Error handling is comprehensive
4. Tests are included for new features

## 📞 Support

For issues or questions:
1. Check the logs first
2. Ensure yt-dlp is updated
3. Verify your configuration
4. Create an issue with logs attached

---

Built with ❤️ for maximum quality and reliability
