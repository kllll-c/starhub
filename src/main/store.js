/**
 * 本地数据存储：设置、收藏、点赞、翻译缓存的持久化。
 * 全部写在系统的 userData 目录，不联网、不上传。
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  githubToken: '',
  translationProvider: 'mymemory', // mymemory | openai | baidu | youdao | off
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiApiKey: '',
  openaiModel: 'gpt-4o-mini',
  baiduAppId: '',
  baiduKey: '',
  youdaoAppKey: '',
  youdaoAppSecret: '',
  myMemoryEmail: '',
  autoTranslate: true,
  autoTranslateReadme: true,
  setupTipDismissed: false,
  theme: 'dark', // dark | light，由标题栏的「亮/暗」按钮切换
  pageSize: 24,
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[store] 写入失败:', file, err.message);
  }
}

class Store {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.settingsFile = path.join(baseDir, 'settings.json');
    this.libraryFile = path.join(baseDir, 'library.json');
    this.settings = { ...DEFAULT_SETTINGS, ...readJson(this.settingsFile, {}) };
    const lib = readJson(this.libraryFile, { favorites: [], likes: [] });
    this.library = {
      favorites: Array.isArray(lib.favorites) ? lib.favorites : [],
      likes: Array.isArray(lib.likes) ? lib.likes : [],
    };
  }

  getSettings() {
    return { ...this.settings };
  }

  saveSettings(patch) {
    const clean = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (patch[key] !== undefined) clean[key] = patch[key];
    }
    this.settings = { ...this.settings, ...clean };
    writeJson(this.settingsFile, this.settings);
    return this.getSettings();
  }

  getLibrary() {
    return {
      favorites: this.library.favorites.slice(),
      likes: this.library.likes.slice(),
    };
  }

  isFavorite(fullName) {
    return this.library.favorites.some((r) => r.fullName === fullName);
  }

  isLiked(fullName) {
    return this.library.likes.some((r) => r.fullName === fullName);
  }

  toggleFavorite(repo) {
    const idx = this.library.favorites.findIndex((r) => r.fullName === repo.fullName);
    if (idx >= 0) {
      this.library.favorites.splice(idx, 1);
      writeJson(this.libraryFile, this.library);
      return { favorited: false, count: this.library.favorites.length };
    }
    this.library.favorites.unshift({ ...repo, savedAt: Date.now() });
    writeJson(this.libraryFile, this.library);
    return { favorited: true, count: this.library.favorites.length };
  }

  toggleLike(repo) {
    const idx = this.library.likes.findIndex((r) => r.fullName === repo.fullName);
    if (idx >= 0) {
      this.library.likes.splice(idx, 1);
      writeJson(this.libraryFile, this.library);
      return { liked: false, count: this.library.likes.length };
    }
    this.library.likes.unshift({ ...repo, likedAt: Date.now() });
    writeJson(this.libraryFile, this.library);
    return { liked: true, count: this.library.likes.length };
  }

  updateRepoSnapshot(repo) {
    let changed = false;
    for (const list of [this.library.favorites, this.library.likes]) {
      const item = list.find((r) => r.fullName === repo.fullName);
      if (item) {
        item.stars = repo.stars;
        item.downloads = repo.downloads ?? item.downloads;
        changed = true;
      }
    }
    if (changed) writeJson(this.libraryFile, this.library);
  }

  stats() {
    return {
      favorites: this.library.favorites.length,
      likes: this.library.likes.length,
    };
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
