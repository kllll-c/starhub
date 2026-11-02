/**
 * 本机 Star 历史快照：每次拉取列表时按「天」记录仓库 Star 数，
 * 用于在没有 GitHub Token 时估算近 7 / 30 日 Star 增速。
 *
 * - 数据只落在 userData 目录，不上传
 * - 每个仓库最多保留 MAX_DAYS 天，全局最多 MAX_REPOS 个仓库
 * - 同一天重复记录会覆盖，不会产生大量重复写入
 */
const fs = require('fs');
const path = require('path');

const MAX_DAYS = 45;
const MAX_REPOS = 3000;
const DAY = 24 * 60 * 60 * 1000;
const MIN_GAP = 6 * 60 * 60 * 1000; // 6 小时内的快照不足以体现变化，计算时忽略

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data.repos === 'object' && data.repos) return data;
  } catch (_) {
    /* 文件不存在或损坏时从空数据开始 */
  }
  return { version: 1, repos: {} };
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[star-history] 写入失败:', file, err.message);
  }
}

class StarHistory {
  constructor(baseDir) {
    this.file = path.join(baseDir, 'star-history.json');
    this.data = readJson(this.file);
    this.dirty = false;
  }

  /**
   * 批量记录当前列表里各仓库的 Star 数（同一天只写一次，避免频繁落盘）。
   */
  recordMany(items, now = Date.now()) {
    const day = dayKey(now);
    for (const item of items || []) {
      if (!item || !item.fullName) continue;
      const stars = Number(item.stars);
      if (!Number.isFinite(stars) || stars < 0) continue;
      const days = this.data.repos[item.fullName] || (this.data.repos[item.fullName] = {});
      if (days[day] === stars) continue;
      days[day] = stars;
      this.dirty = true;
    }
    if (!this.dirty) return;
    this._prune(now);
    writeJson(this.file, this.data);
    this.dirty = false;
  }

  _prune(now) {
    const oldestDay = dayKey(now - MAX_DAYS * DAY);
    for (const [fullName, days] of Object.entries(this.data.repos)) {
      for (const key of Object.keys(days)) {
        if (key < oldestDay) delete days[key];
      }
      if (!Object.keys(days).length) delete this.data.repos[fullName];
    }
    const names = Object.keys(this.data.repos);
    if (names.length <= MAX_REPOS) return;
    // 超出上限时优先丢弃最近一次记录最老的仓库
    names
      .map((name) => {
        const keys = Object.keys(this.data.repos[name]).sort();
        return { name, last: keys[keys.length - 1] || '' };
      })
      .sort((a, b) => (a.last < b.last ? -1 : a.last > b.last ? 1 : 0))
      .slice(0, names.length - MAX_REPOS)
      .forEach(({ name }) => delete this.data.repos[name]);
  }

  /**
   * 计算某仓库在指定窗口内的 Star 增量。
   * 取「最接近窗口起点」的历史快照作为基准（跳过 6 小时内的快照），
   * 并返回实际覆盖的天数，便于界面说明「历史不足」。
   */
  growth(fullName, currentStars, now = Date.now()) {
    const days = this.data.repos[fullName];
    if (!days) return { available: false, reason: '本机还没有该仓库的历史快照' };
    const entries = Object.keys(days)
      .map((key) => ({ ts: Date.parse(`${key}T00:00:00Z`) + DAY, stars: Number(days[key]) }))
      .filter((e) => Number.isFinite(e.ts) && Number.isFinite(e.stars))
      .sort((a, b) => a.ts - b.ts);
    if (!entries.length) return { available: false, reason: '本机还没有该仓库的历史快照' };

    const current = Number(currentStars);
    const base = (windowDays) => {
      const target = now - windowDays * DAY;
      let pick = null;
      let bestDiff = Infinity;
      for (const entry of entries) {
        if (now - entry.ts < MIN_GAP) continue;
        const diff = Math.abs(entry.ts - target);
        if (diff < bestDiff) {
          pick = entry;
          bestDiff = diff;
        }
      }
      return pick;
    };

    const pick7 = base(7);
    const pick30 = base(30);
    if (!pick7 && !pick30) {
      return { available: false, reason: '本机快照不足 6 小时，暂时无法估算增速' };
    }
    const diff = (pick) =>
      pick && Number.isFinite(current) && current >= pick.stars ? current - pick.stars : null;
    return {
      available: true,
      source: 'snapshot',
      growth7: diff(pick7),
      growth30: diff(pick30),
      days7: pick7 ? Math.max(1, Math.round((now - pick7.ts) / DAY)) : null,
      days30: pick30 ? Math.max(1, Math.round((now - pick30.ts) / DAY)) : null,
      capped7: false,
      capped30: false,
    };
  }
}

module.exports = { StarHistory };
