// Pilote automatique : ordre des étapes, échec isolé, arrêt, planification et refus pendant un job manuel.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdb-auto-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.ADMIN_TOKEN = 'x'.repeat(20);
const config = require('../src/config');
const store = require('../src/db');
const ap = require('../src/autopilot');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = [];
const mk = (id, impl) => ({ id, label: `Étape ${id}`, run: async () => { calls.push(id); return impl ? impl() : `${id} ok`; } });

(async () => {
  // 1. Ordre + échec isolé : l'étape B plante, C s'exécute quand même.
  ap._setSteps([mk('a'), mk('b', () => { throw new Error('boom'); }), mk('c'), { ...mk('d'), enabled: () => false }]);
  const st = await ap.run({ trigger: 'manual' });
  assert.deepStrictEqual(calls, ['a', 'b', 'c'], 'ordre respecté, étape désactivée ignorée');
  assert.strictEqual(st.results.length, 3);
  assert.deepStrictEqual(st.results.map((r) => r.ok), [true, false, true], 'un échec n\'arrête pas la suite');
  assert.strictEqual(st.results[1].detail, 'boom');
  assert.strictEqual(st.running, false);
  assert.strictEqual(st.percent, 100);
  assert.ok(st.lastRunAt > 0, 'dernier cycle mémorisé en base');
  assert.ok(Number(store.allSettings().AUTO_LAST_RUN) > 0);
  console.log('  ok  ordre, étape désactivée, échec isolé, horodatage persisté');

  // 2. Pas de cycle en parallèle.
  calls.length = 0;
  ap._setSteps([mk('slow', () => sleep(200).then(() => 'fini'))]);
  const p = ap.run({ trigger: 'manual' });
  await sleep(20);
  await assert.rejects(() => ap.run({ trigger: 'manual' }), /déjà en cours/);
  assert.strictEqual(ap.status().running, true);
  assert.strictEqual(ap.status().step, 'Étape slow');
  await p;
  console.log('  ok  refus d\'un second cycle simultané, étape courante exposée');

  // 3. Arrêt demandé : les étapes suivantes ne démarrent pas et le cycle n'est pas compté comme terminé.
  calls.length = 0;
  store.setSettings({ AUTO_LAST_RUN: '0' });
  ap._setSteps([mk('s1', () => { ap.stop(); return 'x'; }), mk('s2')]);
  const stopped = await ap.run({ trigger: 'manual' });
  assert.deepStrictEqual(calls, ['s1'], 'étape suivante non lancée après arrêt');
  assert.strictEqual(Number(store.allSettings().AUTO_LAST_RUN), 0, 'un cycle interrompu ne repousse pas le prochain');
  assert.strictEqual(stopped.running, false);
  console.log('  ok  arrêt propre sans décaler le planning');

  // 4. Planification : désactivé → jamais ; activé et échéance atteinte → lance un cycle 'auto'.
  calls.length = 0;
  ap._setSteps([mk('auto1')]);
  store.setSettings({ AUTO_LAST_RUN: String(Date.now() - 7 * 3600_000) });  // dernier cycle il y a 7 h, fréquence 6 h
  config.autoEnabled = false; config.autoEveryHours = 6;
  ap.tick(); await sleep(50);
  assert.deepStrictEqual(calls, [], 'désactivé : aucun cycle');
  assert.strictEqual(ap.status().nextRunAt, null);
  config.autoEnabled = true;
  ap.tick(); await sleep(100);
  assert.deepStrictEqual(calls, ['auto1'], 'échéance dépassée : cycle lancé');
  assert.strictEqual(ap.status().trigger, 'auto');
  calls.length = 0;
  ap.tick(); await sleep(50);
  assert.deepStrictEqual(calls, [], 'cycle tout juste terminé : prochain dans 6 h');
  const next = ap.status().nextRunAt;
  assert.ok(next > Date.now() + 5.9 * 3600_000 && next <= Date.now() + 6.01 * 3600_000, 'prochain cycle ≈ +6 h');
  config.autoEveryHours = 2;   // réglage modifié dans le dashboard : pris en compte sans redémarrage
  assert.ok(ap.status().nextRunAt < next - 3.9 * 3600_000, 'nouvelle fréquence appliquée immédiatement');
  console.log('  ok  planification (désactivé, échéance, prochain cycle)');

  // 5. Refus manuel quand un autre job tourne.
  const harvest = require('../src/harvest');
  const real = harvest.status; harvest.status = () => ({ running: true });
  await assert.rejects(() => ap.run({ trigger: 'manual' }), /autre job/);
  assert.throws(() => ap.start({ trigger: 'manual' }), /autre job/);
  harvest.status = real;
  console.log('  ok  refus manuel pendant un job en cours');

  console.log('autopilot.test : OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
