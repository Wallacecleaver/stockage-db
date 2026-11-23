const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');
const { runFfprobe } = require('./quality');
const log = require('./log');

const directory = path.resolve(path.dirname(config.dbPath), 'aiom-youtube');
const videoId = /^[A-Za-z0-9_-]{11}$/;
const maxBytes = 96 * 1024 * 1024;
const maxDiskBytes = 2 * 1024 * 1024 * 1024;
const retryMs = 30 * 60 * 1000;
const active = new Set();
const queue = new Set();
const failures = new Map();
const enabled = () => process.env.AIOM_YOUTUBE_1080_ENABLED === '1';
let cleanup;

async function ready(id) {
  if (!enabled() || !videoId.test(id)) return null;
  const file = path.join(directory, `${id}.mp4`);
  const stat = await fs.stat(file).catch(() => null);
  return stat?.isFile() && stat.size > 0 ? file : null;
}

async function prune(keep) {
  const names = await fs.readdir(directory);
  const files = (await Promise.all(names.filter(name => /^[A-Za-z0-9_-]{11}\.mp4$/.test(name)).map(async name => {
    const file = path.join(directory, name);
    const stat = await fs.stat(file).catch(() => null);
    return stat && { file, size: stat.size, mtime: stat.mtimeMs };
  }))).filter(Boolean).sort((a, b) => a.mtime - b.mtime);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const { file, size } of files) {
    if (total <= maxDiskBytes) break;
    if (file === keep) continue;
    await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    total -= size;
  }
}

async function download(id) {
  await fs.mkdir(directory, { recursive: true });
  cleanup ||= (async () => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    await Promise.all(entries.filter(entry => entry.isDirectory() && /^\.work-[A-Za-z0-9]+$/.test(entry.name)).map(async entry => {
      const file = path.join(directory, entry.name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 3600000) await fs.rm(file, { recursive: true, force: true });
    }));
  })().catch(() => {});
  await cleanup;
  const temporary = await fs.mkdtemp(path.join(directory, '.work-'));
  try {
    const video = 'bv[height=1080][vcodec^=avc1]';
    const audio = 'ba[acodec^=mp4a]';
    const progressive = 'b[height=1080][vcodec^=avc1][acodec^=mp4a]';
    const formats = [video + '+' + audio + '[language^=fr]', progressive + '[language^=fr]',
      video + '+' + audio + '[language=?und]', progressive + '[language=?und]'].join('/');
    const args = ['--ignore-config', '--no-playlist', '--no-cache-dir', '--no-progress',
      '--js-runtimes', 'node', '--socket-timeout', '10', '--retries', '1', '--fragment-retries', '1',
      '--match-filters', 'duration > 0 & duration <= 600 & !is_live', '--max-filesize', '80M',
      '--format', formats, '--merge-output-format', 'mp4', '--output', path.join(temporary, 'trailer.%(ext)s')];
    if (process.env.FFMPEG_PATH) args.push('--ffmpeg-location', process.env.FFMPEG_PATH);
    args.push('--', `https://www.youtube.com/watch?v=${id}`);
    await new Promise((resolve, reject) => {
      execFile(process.env.YT_DLP_PATH || 'yt-dlp', args,
        { timeout: 90000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, windowsHide: true },
        error => error ? reject(error) : resolve());
    });

    const candidate = path.join(temporary, 'trailer.mp4');
    const { size } = await fs.stat(candidate);
    if (!size || size > maxBytes) throw new Error('taille MP4 hors limite');
    const media = await runFfprobe(candidate, { timeoutMs: 10000 });
    if (media.height !== 1080 || !media.hasAudio || media.vcodec !== 'h264' || media.acodec !== 'aac') {
      throw new Error('MP4 1080p H.264/AAC avec son indisponible');
    }
    const file = path.join(directory, `${id}.mp4`);
    await fs.rename(candidate, file);
    await prune(file).catch(error => log.warn('youtube', `Entretien du cache 1080p : ${error.code || 'échec'}`));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function pump() {
  while (active.size < 2 && queue.size) {
    const id = queue.values().next().value;
    queue.delete(id);
    active.add(id);
    download(id).catch(error => {
      failures.set(id, Date.now() + retryMs);
      while (failures.size > 512) failures.delete(failures.keys().next().value);
      log.warn('youtube', 'Bande-annonce AIOM 1080p indisponible', { videoId: id, code: error.code || 'format' });
    }).finally(() => {
      active.delete(id);
      pump();
    });
  }
}

async function requestVideo(id) {
  if (!enabled() || !videoId.test(id)) return 'unavailable';
  if (await ready(id)) return 'ready';
  if (active.has(id) || queue.has(id)) return 'pending';
  if ((failures.get(id) || 0) > Date.now() || queue.size >= 12) return 'unavailable';
  queue.add(id);
  pump();
  return 'pending';
}

module.exports = { videoId, ready, requestVideo };
