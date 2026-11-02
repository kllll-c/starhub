/**
 * 简单的磁盘缓存：key -> { expires, data }。
 * 用于 GitHub 接口结果、README 内容、翻译结果，避免重复消耗接口额度。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha1(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

class DiskCache {
  constructor(dir, { maxFiles = 4000 } = {}) {
    this.dir = dir;
    this.mem = new Map();
    this.maxFiles = maxFiles;
    fs.mkdirSync(dir, { recursive: true });
    this._pruneIfNeeded();
  }

  _file(key) {
    return path.join(this.dir, sha1(key) + '.json');
  }

  _pruneIfNeeded() {
    try {
      const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
      if (files.length <= this.maxFiles) return;
      const withTime = files.map((f) => {
        const p = path.join(this.dir, f);
        return { p, t: fs.statSync(p).mtimeMs };
      });
      withTime.sort((a, b) => a.t - b.t);
      const removeCount = withTime.length - this.maxFiles;
      for (let i = 0; i < removeCount; i += 1) {
        try {
          fs.unlinkSync(withTime[i].p);
        } catch (_) {
          /* ignore */
        }
      }
    } catch (_) {
      /* ignore */
    }
  }

  get(key) {
    const now = Date.now();
    if (this.mem.has(key)) {
      const hit = this.mem.get(key);
      if (hit.expires > now) return hit.data;
      this.mem.delete(key);
      return null;
    }
    try {
      const raw = fs.readFileSync(this._file(key), 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.expires <= now) return null;
      this.mem.set(key, parsed);
      return parsed.data;
    } catch (_) {
      return null;
    }
  }

  set(key, data, ttlMs) {
    const payload = { key, expires: Date.now() + ttlMs, data };
    this.mem.set(key, payload);
    if (this.mem.size > 400) {
      const firstKey = this.mem.keys().next().value;
      this.mem.delete(firstKey);
    }
    try {
      fs.writeFileSync(this._file(key), JSON.stringify(payload));
    } catch (_) {
      /* ignore disk write errors */
    }
  }

  remove(key) {
    this.mem.delete(key);
    try {
      fs.unlinkSync(this._file(key));
    } catch (_) {
      /* ignore */
    }
  }

  clear() {
    this.mem.clear();
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (f.endsWith('.json')) {
          try {
            fs.unlinkSync(path.join(this.dir, f));
          } catch (_) {
            /* ignore */
          }
        }
      }
    } catch (_) {
      /* ignore */
    }
  }

  stats() {
    try {
      return { files: fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).length };
    } catch (_) {
      return { files: 0 };
    }
  }
}

module.exports = { DiskCache, sha1 };
