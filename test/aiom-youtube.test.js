const { after, before, mock, test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const key = 'fixture-stockage-write-key';
const admin = 'fixture-stockage-admin-token';
const media = 'fichier mp4 simulé';
let server, base, dir, store, youtube, download;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stockage-aiom-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  process.env.PUBLIC_URL = 'https://stockage.example';
  process.env.ADMIN_TOKEN = admin;
  process.env.AIOM_YOUTUBE_1080_ENABLED = '0';
  process.env.YT_DLP_PATH = 'fixture-yt-dlp';
  download = mock.method(require('node:child_process'), 'execFile', async (bin, args, opts, callback) => {
    try {
      assert.equal(bin, 'fixture-yt-dlp');
      assert.match(args.at(-1), /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/);
      assert.equal(opts.timeout, 90000);
      assert.ok(args.includes('--no-playlist'));
      assert.match(args[args.indexOf('--format') + 1], /height=1080/);
      const output = args[args.indexOf('--output') + 1].replace('%(ext)s', 'mp4');
      await fs.writeFile(output, args.at(-1).endsWith('bad00000000') ? '720p' : media);
      callback(null, '', '');
    } catch (error) { callback(error); }
  });
  mock.method(require('../src/quality'), 'runFfprobe', async filename => ({
    height: (await fs.readFile(filename, 'utf8')) === media ? 1080 : 720,
    hasAudio: true, vcodec: 'h264', acodec: 'aac',
  }));
  store = require('../src/db');
  store.createApiKey({ label: 'Test AIOM', hash: createHash('sha256').update(key).digest('hex'),
    prefix: key.slice(0, 8), last4: key.slice(-4), scopes: ['trailers:write'] });
  youtube = require('../src/aiom-youtube');
  server = require('../src/app').listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (store) store.db.close();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

function prepare(ytId, apiKey = key) {
  return fetch(base + '/api/v1/aiom-direct/youtube', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey }, body: JSON.stringify({ ytId }) });
}

function saveSetting(value) {
  return fetch(base + '/admin/api/settings', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': admin },
    body: JSON.stringify({ values: { AIOM_YOUTUBE_1080_ENABLED: value } }) });
}

async function waitForResult(id) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = await youtube.requestVideo(id);
    if (state !== 'pending') return state;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Préparation toujours en cours');
}

test('AIOM YouTube exige une clé autorisée et un identifiant de vidéo', async () => {
  assert.equal((await prepare('abcdefghijk', '')).status, 401);
  assert.equal((await prepare('https://example.test')).status, 400);
  assert.equal(download.mock.callCount(), 0);
});

test('AIOM YouTube apparaît dans le dashboard et peut être activé sans redémarrage', async () => {
  const off = await prepare('abcdefghijk');
  assert.equal(off.status, 404);
  assert.match((await off.json()).error, /désactivé/);
  assert.equal(download.mock.callCount(), 0);
  const before = await fetch(base + '/admin/api/summary', { headers: { 'x-admin-token': admin } }).then(r => r.json());
  const item = before.settings.find(group => group.title === 'AIOMetadata').items[0];
  assert.equal(item.key, 'AIOM_YOUTUBE_1080_ENABLED');
  assert.equal(item.value, '0');
  assert.equal(item.needsRestart, false);
  const response = await saveSetting('1');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).restart, []);
  assert.equal(store.allSettings().AIOM_YOUTUBE_1080_ENABLED, '1');
});

test('AIOM YouTube prépare une seule copie, puis sert le MP4 par URL et par plages', async () => {
  const id = 'abcdefghijk';
  const response = await prepare(id);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { pending: true });
  assert.equal(await waitForResult(id), 'ready');
  const ready = await prepare(id);
  assert.equal(ready.status, 200);
  const url = '/aiom-direct/youtube/abcdefghijk.mp4';
  assert.deepEqual(await ready.json(), { height: 1080, url: 'https://stockage.example' + url });
  assert.equal(download.mock.callCount(), 1);
  const head = await fetch(base + url, { method: 'HEAD' });
  assert.match(head.headers.get('content-type'), /^video\/mp4/);
  const range = await fetch(base + url, { headers: { range: 'bytes=0-6' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'fichier');
});

test('AIOM YouTube refuse de publier un fichier sous 1080p, même si le téléchargement réussit', async () => {
  const id = 'bad00000000';
  assert.equal((await prepare(id)).status, 202);
  assert.equal(await waitForResult(id), 'unavailable');
  assert.equal((await prepare(id)).status, 404);
  assert.equal((await fetch(base + `/aiom-direct/youtube/${id}.mp4`)).status, 404);
  assert.equal(download.mock.callCount(), 2);
});

test('AIOM YouTube peut être désactivé à chaud même si un MP4 a déjà été préparé', async () => {
  assert.equal((await saveSetting('0')).status, 200);
  assert.equal((await prepare('abcdefghijk')).status, 404);
  assert.equal((await fetch(base + '/aiom-direct/youtube/abcdefghijk.mp4')).status, 404);
  assert.equal(download.mock.callCount(), 2);
});
