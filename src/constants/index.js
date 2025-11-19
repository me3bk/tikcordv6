// constants/index.js - Application constants
const PLATFORM_PATTERNS = {
  tiktok: /(?:https?:\/\/)?(?:www\.|vm\.|vt\.)?tiktok\.com\/(?:@[\w\.\-]+\/video\/\d+|[@\w\-\.\/]+)/gi,
  instagram: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|tv|stories)\/[\w\-]+(?:\/[\w\-]+)?/gi,
  twitter: /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:twitter|x)\.com\/\w+\/status\/\d+/gi,
  youtube: /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/)[\w\-]+/gi,
  snapchat: /(?:https?:\/\/)?(?:www\.)?snapchat\.com\/(?:add\/[\w\.\-]+\/[A-Za-z0-9_\-]+|t\/[\w\-]+|spotlight\/[\w\-]+)(?:\?[^\s]*)?/gi,
  facebook: /(?:https?:\/\/)?(?:www\.|m\.)?facebook\.com\/(?:watch\/\?v=|reel\/|share\/v\/)[\w\-]+/gi,
  reddit: /(?:https?:\/\/)?(?:www\.)?reddit\.com\/r\/\w+\/comments\/[\w\/]+/gi
};

const EMOJIS = {
  downloading: '⬇️',
  processing: '⚙️',
  success: '✅',
  error: '❌',
  warning: '⚠️',
  queue: '📋',
  tiktok: '🎵',
  instagram: '📸',
  youtube: '▶️',
  twitter: '🐦',
  snapchat: '👻',
  facebook: '📘',
  reddit: '🤖'
};

const QUALITY_BADGES = {
  '4K': { min: 2160, badge: '📺 4K' },
  '1080p': { min: 1080, badge: '🎬 1080p' },
  '720p': { min: 720, badge: '📹 720p' },
  '480p': { min: 480, badge: '📱 480p' },
  'SD': { min: 0, badge: '🎥 SD' }
};

const FILE_HOSTS = {
  GOFILE: {
    name: 'GoFile.io',
    maxSize: Infinity,
    getServerUrl: 'https://api.gofile.io/getServer',
    uploadUrlTemplate: 'https://{server}.gofile.io/uploadFile'
  },
  CATBOX: {
    name: 'Catbox.moe',
    maxSize: 200 * 1024 * 1024, // 200MB
    uploadUrl: 'https://catbox.moe/user/api.php'
  }
};

module.exports = {
  PLATFORM_PATTERNS,
  EMOJIS,
  QUALITY_BADGES,
  FILE_HOSTS
};
