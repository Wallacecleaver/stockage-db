const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { version } = require('../package.json');

// Page du dashboard (HTML autonome : CSS + JS inclus, version injectée depuis package.json).
const HTML = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8').replace(/__APP_VERSION__/g, String(version || '0.0.0'));

// La page pèse ~200 Ko : on la compresse UNE fois au démarrage (Brotli + gzip) au lieu de la renvoyer brute à chaque visite,
// et on la sert avec un ETag pour que le navigateur reçoive un simple 304 quand rien n'a changé.
const RAW = Buffer.from(HTML, 'utf8');
const hash = crypto.createHash('sha1').update(RAW).digest('hex').slice(0, 16);
const VARIANTS = {
  br: {
    encoding: 'br',
    etag: `"${hash}-br"`,
    body: zlib.brotliCompressSync(RAW, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: RAW.length },
    }),
  },
  gzip: { encoding: 'gzip', etag: `"${hash}-gz"`, body: zlib.gzipSync(RAW, { level: 9 }) },
  identity: { encoding: null, etag: `"${hash}"`, body: RAW },
};

/** Variante de la page adaptée à l'en-tête Accept-Encoding du navigateur (Brotli > gzip > brut). */
function pickVariant(acceptEncoding) {
  const ae = String(acceptEncoding || '').toLowerCase();
  if (/(^|[\s,])br(\s*;|\s*,|$)/.test(ae)) return VARIANTS.br;
  if (/(^|[\s,])gzip(\s*;|\s*,|$)/.test(ae)) return VARIANTS.gzip;
  return VARIANTS.identity;
}

module.exports = { HTML, pickVariant };
