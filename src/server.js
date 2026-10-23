// HTTP API + static frontend + Server-Sent Events stream.
import express from 'express';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ROLLUPS } from '../config/rollups.js';
import { PREFERENCES } from './core/router.js';
import { ROOT, DEPLOYMENTS_FILE } from './chain/artifacts.js';
import { Rollup } from './chain/rollup.js';
import { IntentService } from './service.js';
import { runSweep } from './sim/simulator.js';

export function createApp(service) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(ROOT, 'public')));
  app.use('/vendor', express.static(path.join(ROOT, 'node_modules/chart.js/dist')));

  const rollupList = () => [...service.rollups.values()].map((r) => r.snapshot());
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };

  app.get('/api/config', (_req, res) => res.json({ preferences: PREFERENCES, rollups: rollupList() }));
  app.get('/api/rollups', (_req, res) => res.json(rollupList()));
  app.get('/api/balances', wrap(() => service.balances()));
  app.post('/api/quote', wrap((req) => service.quote(req.body)));
  app.post('/api/intents', wrap((req) => service.view(service.submit(req.body))));
  app.get('/api/intents', (_req, res) => res.json(service.list()));
  app.get('/api/intents/:id', (req, res) => {
    const rec = service.intents.get(req.params.id);
    if (!rec) return res.status(404).json({ error: 'not found' });
    res.json(service.view(rec));
  });
  app.get('/api/stats', (_req, res) => res.json(service.stats()));

  // Demo controls: emulate congestion or a sequencer outage on one rollup.
  const rollupOr404 = (req, res) => {
    const r = service.rollups.get(req.params.id);
    if (!r) res.status(404).json({ error: 'unknown rollup' });
    return r;
  };
  app.post('/api/rollups/:id/congest', async (req, res) => {
    const r = rollupOr404(req, res);
    if (!r) return;
    // Default: enough 21k-gas spam transfers to fill ~6 blocks of this rollup.
    const count = Math.min(Number(req.body?.count ?? Math.round((6 * r.profile.blockGasLimit) / 21_000)), 2000);
    r.congest(count).catch((err) => console.error('congest failed', err.message));
    res.json({ ok: true, count });
  });
  app.post('/api/rollups/:id/halt', wrap(async (req) => {
    const r = service.rollups.get(req.params.id);
    if (!r) throw new Error('unknown rollup');
    await r.halt();
    return { ok: true };
  }));
  app.post('/api/rollups/:id/resume', wrap(async (req) => {
    const r = service.rollups.get(req.params.id);
    if (!r) throw new Error('unknown rollup');
    await r.resume();
    return { ok: true };
  }));

  // Offline load simulation (scalability analysis); pure JS, runs in ~1s.
  app.get('/api/sim', (req, res) => {
    const file = path.join(ROOT, 'results', 'sim-results.json');
    if (req.query.fresh !== '1' && existsSync(file)) return res.json(JSON.parse(readFileSync(file, 'utf8')));
    res.json(runSweep());
  });

  // Live updates.
  app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onIntent = (rec) => send('intent', rec);
    service.on('intent', onIntent);
    const timer = setInterval(() => send('rollups', rollupList()), 1000);
    send('rollups', rollupList());
    req.on('close', () => {
      clearInterval(timer);
      service.off('intent', onIntent);
    });
  });

  return app;
}

/** Connect to already-running chains described in deployments.json. */
export async function startServer({ deployments, profiles = ROLLUPS, port = Number(process.env.PORT ?? 3000) } = {}) {
  deployments ??= JSON.parse(readFileSync(DEPLOYMENTS_FILE, 'utf8'));
  const rollups = profiles.map((p) => new Rollup(p, deployments[p.id]));
  await Promise.all(rollups.map((r) => r.startMonitor(700)));
  const service = new IntentService(rollups);
  const app = createApp(service);
  const server = await new Promise((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });
  return {
    service,
    server,
    url: `http://localhost:${port}`,
    close: () => {
      rollups.forEach((r) => r.stopMonitor());
      server.closeAllConnections?.();
      server.close();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!existsSync(DEPLOYMENTS_FILE)) {
    console.error('deployments.json not found. Use "npm run demo" (starts chains + deploys + server).');
    process.exit(1);
  }
  const { url } = await startServer();
  console.log(`Intent router UI: ${url}`);
}
