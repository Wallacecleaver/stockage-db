// Pilote automatique : enchaîne tout seul, à intervalle réglable, la collecte des dernières sorties
// (TMDB, Netflix/JustWatch, Apple TV+) puis l'extraction de leurs bandes-annonces.
// Réglages dans l'onglet Paramètres → « Automatisation » (aucun redémarrage nécessaire).
const config = require('./config');
const store = require('./db');
const log = require('./log');

const LAST_RUN_KEY = 'AUTO_LAST_RUN';   // horodatage persisté : un redémarrage ne relance pas tout de suite un cycle récent
const POLL_MS = 60_000;                 // le planificateur vérifie toutes les minutes s'il est temps de lancer un cycle
const STARTUP_DELAY_MS = 90_000;        // laisse le serveur et les jobs de reprise démarrer avant le premier cycle
const BUSY_RETRY_MS = 10 * 60_000;      // un job manuel tourne : on réessaie dans 10 min au lieu de se marcher dessus

// Chaque étape : un nom lisible, une condition d'activation, et soit un `run` asynchrone, soit un module de job (start/status/stop).
const lazy = (name) => () => require(name);
const STEPS = [
  { id: 'tmdb', label: 'Nouveautés TMDB (Netflix, Apple TV+)', enabled: () => !!config.tmdbKey,
    run: async () => `+${await require('./sync').syncRecent()} titre(s)` },
  { id: 'harvest', label: 'Dernières sorties Netflix (JustWatch)', job: lazy('./harvest'), opts: () => ({ recent: true }),
    summary: (s) => `${s.added || 0} ajouté(s), ${s.linked || 0} lié(s)` },
  { id: 'link', label: 'Association des IDs Netflix', job: lazy('./link'), opts: (n) => ({ limit: n }),
    summary: (s) => `${s.linked || 0} lié(s) sur ${s.total || 0}` },
  { id: 'vf', label: 'Identifiants IMDb / TMDB & VF', enabled: () => !!config.tmdbKey, job: lazy('./vf'), opts: (n) => ({ limit: n }),
    summary: (s) => `${s.matched || 0} lié(s), ${s.noMatch || 0} sans fiche` },
  { id: 'netflix', label: 'Pages Netflix → flux MP4', job: lazy('./netflix-trailers'), opts: (n) => ({ limit: n }),
    summary: (s) => `${s.found || 0} flux sur ${s.total || 0} page(s)` },
  { id: 'appletv', label: 'Apple TV+ → flux HLS/MP4', enabled: () => !!config.appletvEnabled, job: lazy('./appletv'), opts: (n) => ({ limit: n }),
    summary: (s) => `${s.found || 0} trouvé(s) sur ${s.total || 0} fiche(s)` },
];

const state = {
  running: false, stopRequested: false, trigger: null,
  step: null, stepIndex: 0, stepCount: 0,
  startedAt: null, finishedAt: null,
  results: [], error: null,
};
let steps = STEPS;          // remplaçable par les tests
let timer = null;
let currentJob = null;      // module du job en cours (pour pouvoir l'arrêter)
let retryAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hours = () => Math.max(1, Number(config.autoEveryHours) || 6);
const lastRun = () => Number(store.allSettings()[LAST_RUN_KEY]) || 0;
let bootDue = Date.now() + STARTUP_DELAY_MS;   // premier cycle si aucun n'a jamais tourné
// Recalculée à chaque appel : modifier la fréquence dans Paramètres s'applique tout de suite, sans redémarrage.
const computeNext = () => (lastRun() ? lastRun() + hours() * 3600_000 : bootDue);

/** Vrai si un job lancé à la main (ou la reprise de démarrage) est en cours : on ne se marche pas dessus. */
function otherJobRunning() {
  for (const m of ['./harvest', './link', './vf', './appletv', './netflix-trailers']) {
    try { if (require(m).status().running) return true; } catch { /* module indisponible */ }
  }
  return false;
}

function status() {
  return {
    enabled: !!config.autoEnabled,
    everyHours: hours(),
    batch: Math.max(1, Number(config.autoBatch) || 300),
    running: state.running,
    trigger: state.trigger,
    step: state.step, stepIndex: state.stepIndex, stepCount: state.stepCount,
    percent: state.running ? Math.round(((state.stepIndex - 1) / Math.max(1, state.stepCount)) * 100) : (state.finishedAt ? 100 : 0),
    startedAt: state.startedAt, finishedAt: state.finishedAt,
    lastRunAt: lastRun() || null,
    nextRunAt: config.autoEnabled && !state.running ? computeNext() : null,
    results: state.results,
    error: state.error,
  };
}

async function runStep(s, batch) {
  if (s.run) return s.run();
  const mod = s.job();
  currentJob = mod;
  mod.start(s.opts(batch));
  await sleep(300);                                  // laisse le job passer à « running »
  while (mod.status().running) {
    if (state.stopRequested) { mod.stop?.(); }
    await sleep(1500);
  }
  currentJob = null;
  return s.summary(mod.status());
}

/** Lance un cycle complet. `trigger` : 'auto' (planifié) ou 'manual' (bouton du dashboard). */
async function run({ trigger = 'auto' } = {}) {
  if (state.running) throw new Error('Un cycle automatique est déjà en cours');
  if (trigger === 'manual' && otherJobRunning()) throw new Error('Un autre job est en cours : attends sa fin ou arrête-le');
  const active = steps.filter((s) => !s.enabled || s.enabled());
  const batch = Math.max(1, Number(config.autoBatch) || 300);
  Object.assign(state, {
    running: true, stopRequested: false, trigger, step: null, stepIndex: 0, stepCount: active.length,
    startedAt: Date.now(), finishedAt: null, results: [], error: null,
  });
  log.info('auto', `Cycle automatique lancé (${trigger === 'manual' ? 'manuel' : 'planifié'}, ${active.length} étapes)`);
  try {
    for (const s of active) {
      if (state.stopRequested) break;
      state.step = s.label; state.stepIndex += 1;
      const t0 = Date.now();
      try {
        const detail = await runStep(s, batch);
        state.results.push({ id: s.id, label: s.label, ok: true, detail: String(detail || ''), ms: Date.now() - t0 });
      } catch (e) {
        // Une étape en échec n'interrompt pas les suivantes : elles sont indépendantes.
        state.results.push({ id: s.id, label: s.label, ok: false, detail: e.message, ms: Date.now() - t0 });
        log.error('auto', `Étape « ${s.label} » en échec : ${e.message}`);
      }
    }
  } finally {
    state.running = false; state.step = null; currentJob = null;
    state.finishedAt = Date.now();
    if (!state.stopRequested) store.setSettings({ [LAST_RUN_KEY]: String(state.finishedAt) });
    const failed = state.results.filter((r) => !r.ok).length;
    log.info('auto', `Cycle automatique ${state.stopRequested ? 'arrêté' : 'terminé'} : ${state.results.length - failed} étape(s) OK, ${failed} en échec`);
  }
  return status();
}

function start(opts = {}) {
  if (state.running) return status();
  if (opts.trigger === 'manual' && otherJobRunning()) throw new Error('Un autre job est en cours : attends sa fin ou arrête-le');
  run(opts).catch((e) => { state.error = e.message; log.error('auto', e.message); });
  return status();
}

function stop() {
  state.stopRequested = true;
  try { currentJob && currentJob.stop && currentJob.stop(); } catch { /* ignore */ }
  return status();
}

function tick() {
  if (!config.autoEnabled || state.running) return;
  if (Date.now() < computeNext() || Date.now() < retryAt) return;
  if (otherJobRunning()) { retryAt = Date.now() + BUSY_RETRY_MS; return; }
  start({ trigger: 'auto' });
}

function schedule() {
  if (timer) return;
  bootDue = Date.now() + STARTUP_DELAY_MS;
  timer = setInterval(tick, POLL_MS);
  timer.unref();
}

/** Pour les tests : remplace la liste d'étapes et réinitialise l'état. */
function _setSteps(list) { steps = list || STEPS; }

module.exports = { run, start, stop, status, schedule, tick, _setSteps };
