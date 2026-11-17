#!/usr/bin/env node
'use strict';

/**
 * End-to-end test of the real app: Electron + bundled aria2 + a local HTTP
 * server, driven through the UI the way a person would (pasting links,
 * clicking buttons). Runs in an isolated profile and download folder.
 *
 *   npm run vendor                                   # needs vendor/bin/aria2c
 *   node scripts/app-e2e.js                          # macOS / Windows
 *   xvfb-run -a node scripts/app-e2e.js              # Linux without a display
 *
 * Needs Playwright (npm i -D playwright). Exits non-zero on any failure.
 */

const { _electron: electron } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const ARIA2C = path.join(ROOT, 'vendor', 'bin', IS_WIN ? 'aria2c.exe' : 'aria2c');
const ELECTRON = require('electron'); // path to the binary when required from node

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/* ---------- local server ---------- */

const SLOW = Buffer.alloc(6 * 1024 * 1024, 7); // ~10s at 640 KB/s
const SMALL = Buffer.alloc(40 * 1024, 3);

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = url.pathname.split('/')[1];

    if (route === 'missing') {
      res.writeHead(404);
      return res.end('nope');
    }
    if (route === 'small') {
      res.writeHead(200, { 'Content-Length': SMALL.length });
      return res.end(SMALL);
    }
    if (route === 'nolen') {
      // No Content-Length: size unknown until the end.
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      let sent = 0;
      const timer = setInterval(() => {
        if (sent >= 512 * 1024) {
          clearInterval(timer);
          return res.end();
        }
        res.write(SMALL.subarray(0, 32 * 1024));
        sent += 32 * 1024;
      }, 60);
      req.on('close', () => clearInterval(timer));
      return undefined;
    }

    // slow (default): throttled, honours Range so resume works
    let start = 0;
    const range = /bytes=(\d+)-/.exec(req.headers.range || '');
    if (range) start = Number(range[1]);
    const body = SLOW.subarray(start);
    res.writeHead(range ? 206 : 200, {
      'Content-Length': body.length,
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${SLOW.length - 1}/${SLOW.length}` } : {}),
    });
    let i = 0;
    const timer = setInterval(() => {
      if (i >= body.length) {
        clearInterval(timer);
        return res.end();
      }
      res.write(body.subarray(i, i + 64 * 1024));
      i += 64 * 1024;
    }, 100);
    req.on('close', () => clearInterval(timer));
    return undefined;
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ---------- app harness ---------- */

async function launch(home) {
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), ROOT],
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, 'AppData') },
  });
  const win = await app.firstWindow();
  win.on('pageerror', (err) => check(`no page errors (${err.message})`, false));
  await win.waitForFunction(() => document.querySelector('#engine-label').textContent === 'ready to roll', null, {
    timeout: 20000,
  });
  return { app, win };
}

function profile() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dung-e2e-'));
  const dl = path.join(home, 'Downloads');
  fs.mkdirSync(dl);
  const settings = JSON.stringify({ dir: dl, aria2Path: ARIA2C, connections: 1, split: 1, verifyDmg: false });
  // userData folder name differs by platform / packaging; write all spellings.
  for (const dir of [
    path.join(home, '.config', 'dung'),
    path.join(home, 'Library', 'Application Support', 'dung'),
    path.join(home, 'AppData', 'dung'),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), settings);
  }
  return { home, dl };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ui(win) {
  const ev = (fn, arg) => win.evaluate(fn, arg);
  return {
    ev,
    paste: (text) =>
      ev((t) => {
        const input = document.querySelector('#url-input');
        input.value = t;
        input.dispatchEvent(new Event('paste'));
      }, text),
    mode: () => ev(() => document.querySelector('.app').dataset.mode),
    items: () => ev(() => window.__items || []),
    banner: () =>
      ev(() => {
        const b = document.querySelector('#error-banner');
        return b.hidden ? null : { text: document.querySelector('#error-text').textContent, note: b.classList.contains('is-note'), reveal: !document.querySelector('#error-reveal').hidden };
      }),
    conflictOpen: () => ev(() => !document.querySelector('#conflict-modal').hidden),
    click: (selector) => ev((s) => document.querySelector(s).click(), selector),
    waitFor: (fn, arg, timeout = 30000) => win.waitForFunction(fn, arg, { timeout }),
    clearAll: async () => {
      await ev(async () => {
        for (const item of window.__items || []) await window.api.remove(item.gid);
        await window.api.clearFinished();
        document.querySelector('#error-banner').hidden = true;
      });
      await sleep(1500);
    },
  };
}

async function exposeItems(win) {
  // Mirror the raw engine payload so checks can look at real state.
  await win.evaluate(() => {
    window.api.onUpdate((payload) => {
      window.__items = payload.items || [];
      window.__lastHistory = payload.history || [];
    });
  });
}

/* ---------- scenarios ---------- */

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const { home, dl } = profile();
  let { app, win } = await launch(home);
  await exposeItems(win);
  let u = ui(win);
  const files = () => fs.readdirSync(dl).filter((f) => !f.endsWith('.aria2')).sort();

  // 1. Same link pasted three times quickly
  await u.paste(`${base}/slow/a.bin`);
  await sleep(100);
  await u.paste(`${base}/slow/a.bin`);
  await sleep(100);
  await u.paste(`${base}/slow/a.bin`);
  await sleep(2500);
  check('rapid identical pastes -> one download', (await u.items()).length === 1, `${(await u.items()).length} items`);
  check('no conflict dialog for duplicates', !(await u.conflictOpen()));
  const dupNote = await u.banner();
  check('calm "already rolling" note', Boolean(dupNote && dupNote.note && /Already rolling/.test(dupNote.text)), JSON.stringify(dupNote));

  // 2. Same file name from a different link while the first is busy
  await u.paste(`${base}/slow/a.bin?mirror=2`);
  await sleep(3000);
  const names = (await u.items()).map((item) => item.name).sort();
  check('different link, same name -> downloads alongside', names.includes('a (1).bin') || names.length === 2, JSON.stringify(names));
  check('...and never offers Overwrite on a busy file', !(await u.conflictOpen()));
  check('two downloads -> lanes', (await u.mode()) === 'lanes');

  // 3. Pause / resume (and pausing something that just finished is not an error)
  check('pausing a finished download is quiet', await u.ev(async () => { try { await window.api.pause('0000000000000000'); return true; } catch (e) { return e.message; } }) === true);
  const first = (await u.items()).find((item) => item.name === 'a.bin');
  await u.ev((gid) => window.api.pause(gid), first.gid);
  await sleep(1500);
  check('pause', (await u.items()).find((i) => i.gid === first.gid).status === 'paused');
  await u.ev((gid) => window.api.resume(gid), first.gid);
  await sleep(1500);
  check('resume', ['active', 'complete'].includes((await u.items()).find((i) => i.gid === first.gid).status));

  // 4. Both finish -> files on disk, no idle flash, then one finished on Home
  await u.ev(() => {
    window.__modes = [];
    new MutationObserver(() => window.__modes.push(document.querySelector('.app').dataset.mode)).observe(
      document.querySelector('.app'),
      { attributes: true, attributeFilter: ['data-mode'] }
    );
  });
  await u.waitFor(() => (window.__items || []).filter((i) => i.status === 'complete').length >= 2, null, 60000);
  await sleep(1000);
  check('both files complete on disk', files().includes('a.bin') && files().includes('a (1).bin'), JSON.stringify(files()));
  check('a.bin has the right size', fs.statSync(path.join(dl, 'a.bin')).size === SLOW.length);
  check('no flash to idle while finishing', !(await u.ev(() => window.__modes.includes('idle'))), await u.ev(() => window.__modes.join('>')));
  await sleep(9000);
  check('finished lanes fold back to one finish screen', (await u.mode()) === 'active');
  check('finish screen offers Open', await u.ev(() => Boolean(document.querySelector('#stage-actions [data-action="open"]'))));

  // 5. Pasting a link you already have
  const before = (await u.items()).length;
  await u.paste(`${base}/slow/a.bin`);
  await sleep(2000);
  const have = await u.banner();
  check('already have it -> note, no new download', (await u.items()).length === before && Boolean(have && /already have/i.test(have.text)), JSON.stringify(have));
  check('...with a Show file button', Boolean(have && have.reveal));
  check('...and a Download again button', await u.ev(() => !document.querySelector('#note-again').hidden));
  const originalBytes = fs.statSync(path.join(dl, 'a.bin')).size;
  await u.click('#note-again');
  await u.waitFor(() => (window.__items || []).some((i) => i.name === 'a (2).bin' && i.status === 'complete'), null, 60000).catch(() => {});
  check('Download again saves a copy alongside', files().includes('a (2).bin'), JSON.stringify(files()));
  check('...and leaves the original untouched', fs.statSync(path.join(dl, 'a.bin')).size === originalBytes);

  // 6. Deleted the file -> pasting downloads it again
  await u.clearAll();
  fs.rmSync(path.join(dl, 'a.bin'));
  await u.paste(`${base}/slow/a.bin`);
  await sleep(2000);
  check('file deleted -> pasting downloads again', (await u.items()).some((i) => i.name === 'a.bin' && ['active', 'waiting', 'complete'].includes(i.status)));

  // 7. Cancel mid-download, then paste again
  const running = (await u.items()).find((i) => i.name === 'a.bin');
  await u.ev((gid) => window.api.remove(gid), running.gid);
  await sleep(1500);
  check('cancel removes it', !(await u.items()).some((i) => i.gid === running.gid));
  await u.paste(`${base}/slow/a.bin`);
  await sleep(2500);
  const again = (await u.items()).find((i) => i.name === 'a.bin');
  check('re-paste after cancel downloads (resumes or restarts)', Boolean(again && ['active', 'complete'].includes(again.status)), again && `${again.status} ${again.errorMessage}`);
  check('...without a conflict dialog', !(await u.conflictOpen()));
  await u.waitFor(() => (window.__items || []).some((i) => i.name === 'a.bin' && i.status === 'complete'), null, 60000);
  check('re-pasted file completes with right size', fs.statSync(path.join(dl, 'a.bin')).size === SLOW.length);
  await u.clearAll();

  // 8. A file Dung did not make is in the way -> conflict dialog, Keep Both
  fs.writeFileSync(path.join(dl, 'mine.bin'), 'my own file');
  await u.paste(`${base}/small/mine.bin`);
  await u.waitFor(() => !document.querySelector('#conflict-modal').hidden, null, 10000).catch(() => {});
  check('foreign file in the way -> conflict dialog', await u.conflictOpen());
  if (await u.conflictOpen()) {
    await u.click('#conflict-keep');
    await sleep(2500);
    check('Keep Both keeps mine and adds a copy', fs.readFileSync(path.join(dl, 'mine.bin'), 'utf8') === 'my own file' && files().includes('mine (1).bin'), JSON.stringify(files()));
  }
  await u.clearAll();

  // 9. Errors read like Dung, and can be dismissed
  await u.paste(`${base}/missing/gone.bin`);
  await u.waitFor(() => (window.__items || []).some((i) => i.status === 'error'), null, 15000).catch(() => {});
  await u.waitFor(() => /not found|404|dropped/i.test(document.querySelector('#current-meta').textContent + [...document.querySelectorAll('.lane')].map((l) => l.innerText).join(' ')), null, 5000).catch(() => {});
  const shown404 = await u.ev(() => ({ transitioning, mode: document.querySelector('.app').dataset.mode, meta: document.querySelector('#current-meta').textContent, lanes: [...document.querySelectorAll('.lane')].map((l) => l.innerText.replace(/\s+/g, ' ')) }));
  check('404 -> dropped with a reason', /not found|404|dropped/i.test(shown404.meta + shown404.lanes.join(' ')), JSON.stringify(shown404));
  await u.ev(() => document.querySelector('#stage-actions [data-action="remove"]') && document.querySelector('#stage-actions [data-action="remove"]').click());
  await sleep(1500);
  check('Dismiss clears the error', !(await u.items()).some((i) => i.status === 'error'));

  await u.paste('http://127.0.0.1:9/unreachable.bin');
  await u.waitFor(() => (window.__items || []).some((i) => i.status === 'error'), null, 20000).catch(() => {});
  check('unreachable server -> error, app stays usable', (await u.items()).some((i) => i.status === 'error') && (await u.mode()) !== undefined);
  await u.clearAll();

  // 10. Unknown size and unicode names
  await u.paste(`${base}/nolen/stream.bin`);
  await u.waitFor(() => (window.__items || []).some((i) => i.name === 'stream.bin' && i.status === 'complete'), null, 30000).catch(() => {});
  check('download without a size completes', files().includes('stream.bin'));
  await u.paste(`${base}/small/${encodeURIComponent('café 文件 🪲.bin')}`);
  await u.waitFor(() => (window.__items || []).some((i) => i.status === 'complete' && /caf/.test(i.name)), null, 15000).catch(() => {});
  check('unicode file name', files().some((f) => f.startsWith('caf')), JSON.stringify(files()));
  await u.clearAll();

  // 11. Two links in one paste
  await u.paste(`${base}/slow/x.bin ${base}/slow/y.bin`);
  await sleep(2500);
  check('two links in one paste -> two lanes', (await u.mode()) === 'lanes' && (await u.items()).length === 2);
  await u.clearAll();

  // 12. Junk, YouTube, and pasting behind a dialog
  await u.paste('just some words');
  await sleep(300);
  const junk = await u.banner();
  check('non-link text -> friendly hint', Boolean(junk && /doesn.t look like a link/i.test(junk.text)));
  await u.paste('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await sleep(800);
  check('YouTube -> Not supported dialog', await u.ev(() => !document.querySelector('#modal').hidden));
  await u.click('#modal-ok');
  await u.click('#settings-btn');
  await u.ev((t) => {
    const e = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true });
    e.clipboardData.setData('text', t);
    document.body.dispatchEvent(e);
  }, `${base}/small/behind.bin`);
  await sleep(1200);
  check('paste behind Settings is ignored', !(await u.items()).some((i) => i.name === 'behind.bin'));
  await u.click('#settings-done');

  // 13. aria2 crashes mid-download -> recovers on its own
  await u.paste(`${base}/slow/crash.bin`);
  await sleep(2000);
  try {
    if (IS_WIN) execFileSync('taskkill', ['/F', '/IM', 'aria2c.exe']);
    else execFileSync('pkill', ['-9', '-f', ARIA2C]);
  } catch {
    /* ignore */
  }
  // Wait for the crash to reach the UI first: right after the kill the label
  // can still say "ready to roll" from before, which would end the wait early.
  const label = () => u.ev(() => document.querySelector('#engine-label').textContent);
  await u.waitFor(() => document.querySelector('#engine-label').textContent !== 'ready to roll', null, 10000).catch(() => {});
  const during = await label();
  check('the crash is noticed', during !== 'ready to roll', during);
  await u.waitFor(() => document.querySelector('#engine-label').textContent === 'ready to roll', null, 20000).catch(() => {});
  check('downloader restarts itself after a crash', (await label()) === 'ready to roll', await label());
  check('recovery card gone once back', await u.ev(() => document.querySelector('#setup-card').hidden));
  await u.paste(`${base}/small/after-crash.bin`);
  await u.waitFor(() => (window.__items || []).some((i) => i.name === 'after-crash.bin' && i.status === 'complete'), null, 20000).catch(() => {});
  check('downloads work after the crash', files().includes('after-crash.bin'));

  // 15. A finished file deleted in Finder/Explorer
  await u.clearAll();
  await u.paste(`${base}/small/vanish.bin`);
  await u.waitFor(() => (window.__items || []).some((i) => i.name === 'vanish.bin' && i.status === 'complete'), null, 15000);
  fs.rmSync(path.join(dl, 'vanish.bin'));
  await u.waitFor(() => /moved or deleted/.test(document.querySelector('#current-meta').textContent), null, 6000).catch(() => {});
  check('deleted file: finish screen says it was moved or deleted', /moved or deleted/.test(await u.ev(() => document.querySelector('#current-meta').textContent)));
  check('...and offers Download again instead of Open', await u.ev(() => Boolean(document.querySelector('#stage-actions [data-action="again"]')) && !document.querySelector('#stage-actions [data-action="open"]')));
  await u.click('#door-handle');
  await sleep(600);
  check('History marks it "wandered off"', await u.ev(() => [...document.querySelectorAll('#list .item')].some((row) => /vanish\.bin/.test(row.textContent) && /wandered off/i.test(row.textContent))));
  const opened = await u.ev(() => window.api.open(document.querySelector('#list .item [data-path]') ? [...document.querySelectorAll('#list [data-path]')].find((b) => /vanish/.test(b.dataset.path)).dataset.path : ''));
  check('Open on a deleted file reports it instead of failing silently', Boolean(opened && opened.missing), JSON.stringify(opened));
  await u.click('#door-handle');
  await sleep(600);
  await u.click('#stage-actions [data-action="again"]');
  await u.waitFor(() => (window.__items || []).filter((i) => i.name === 'vanish.bin' && i.status === 'complete').length >= 1 && !/moved or deleted/.test(document.querySelector('#current-meta').textContent), null, 15000).catch(() => {});
  await sleep(1000);
  check('Download again brings the file back', files().includes('vanish.bin'), JSON.stringify(files()));

  // 16. Magnet link through a local swarm: a finished torrent is "rolled home"
  //     (not rolling at 100% while it seeds); the metadata step stays hidden
  await u.clearAll();
  const { startSwarm } = require('./lib/swarm');
  const swarm = await startSwarm({ aria2c: ARIA2C, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dung-swarm-')) });
  try {
    await u.ev(() => {
      window.__shown = new Set();
      window.api.onUpdate((p) => (p.items || []).forEach((i) => window.__shown.add(`${i.name}|${i.status}`)));
    });
    await u.paste(swarm.magnet);
    await u.waitFor(() => (window.__items || []).some((i) => i.torrent && i.status === 'complete'), null, 60000).catch(() => {});
    await sleep(3000);
    const t = (await u.items()).find((i) => i.torrent && i.name === 'swarm-file.bin');
    check('magnet downloads through the swarm', Boolean(t) && fs.existsSync(path.join(dl, 'swarm-file.bin')) && fs.statSync(path.join(dl, 'swarm-file.bin')).size === swarm.size, JSON.stringify(t));
    check('finished torrent is complete, not "rolling" while it seeds', Boolean(t) && t.status === 'complete', t && t.status);
    const label = await u.ev(() => [document.querySelector('#current-name').textContent, document.querySelector('#current-badges').textContent].join(' | '));
    check('Home says rolled home for it', /swarm-file\.bin/.test(label) && /rolled home/i.test(label), label);
    const shown = await u.ev(() => [...window.__shown]);
    check('metadata step never shows as its own finished file', !shown.some((s) => /METADATA/i.test(s)) && !shown.some((s) => /^Torrent info\|complete/.test(s)), JSON.stringify(shown));
    await u.paste(swarm.magnet.replace(/&dn=[^&]*/, '&dn=other-name'));
    await sleep(1500);
    const again = await u.banner();
    check('same torrent with a different magnet link is recognised', Boolean(again && /already have/i.test(again.text)), JSON.stringify(again));
  } finally {
    swarm.stop();
  }
  await u.clearAll();

  // 17. Average speed counts active time only (a pause doesn't drag it down)
  await u.clearAll();
  await u.paste(`${base}/slow/timed.bin`);
  await u.waitFor(() => (window.__items || []).some((i) => i.name === 'timed.bin' && i.status === 'active' && i.completedLength > 1e6), null, 15000);
  const timedGid = (await u.items()).find((i) => i.name === 'timed.bin').gid;
  const t0 = Date.now();
  await u.ev((gid) => window.api.pause(gid), timedGid);
  await sleep(4000);
  await u.ev((gid) => window.api.resume(gid), timedGid);
  await u.waitFor(() => (window.__items || []).some((i) => i.name === 'timed.bin' && i.status === 'complete'), null, 60000);
  await sleep(1500);
  const timed = await u.ev(() => (window.__lastHistory || []).find((e) => e.name === 'timed.bin'));
  const speed = timed && timed.avgSpeed;
  check('History records the average speed', Boolean(speed), JSON.stringify(timed));
  // The test server sends ~640 KB/s; a wall-clock average would include the 4s pause.
  check('...counting only active time (pause excluded)', speed > 450 * 1024 && speed < 900 * 1024 && timed.activeMs < Date.now() - t0, `${Math.round((speed || 0) / 1024)} KB/s over ${timed && timed.activeMs}ms`);

  // 18. Remove from list keeps the file; Move to Trash + Undo keeps it; Move to Trash moves it
  const trashDir = path.join(home, '.local', 'share', 'Trash', 'files');
  const inTrash = (name) => fs.existsSync(trashDir) && fs.readdirSync(trashDir).some((f) => f.startsWith(name.replace(/\.bin$/, '')));
  await u.ev(() => document.querySelector('#stage-actions [data-action="remove"]').click());
  await sleep(1500);
  check('Remove from list keeps the file on disk', files().includes('timed.bin'));
  await u.click('#door-handle');
  await sleep(600);
  const trashBtn = () => u.ev(() => { const r = [...document.querySelectorAll('#list .item')].find((x) => /timed\.bin/.test(x.textContent)); r.querySelector('[data-action="trash"]').click(); });
  await trashBtn();
  await sleep(500);
  check('Move to Trash hides it at once', !(await u.ev(() => [...document.querySelectorAll('#list .item')].some((x) => /timed\.bin/.test(x.textContent)))));
  await u.click('#note-undo');
  await sleep(8000);
  check('Undo keeps the file and brings the entry back', files().includes('timed.bin') && (await u.ev(() => [...document.querySelectorAll('#list .item')].some((x) => /timed\.bin/.test(x.textContent)))));
  await trashBtn();
  await sleep(8500);
  check('without Undo, the file goes to the Trash', !files().includes('timed.bin') && inTrash('timed.bin'), JSON.stringify(files()));
  check('...and leaves the list', !(await u.ev(() => [...document.querySelectorAll('#list .item')].some((x) => /timed\.bin/.test(x.textContent)))));
  await u.click('#door-handle');
  await sleep(600);

  // 19. Cancel moves the partial file and its .aria2 progress file to the Trash
  await u.paste(`${base}/slow/partial.bin`);
  await u.waitFor(() => (window.__items || []).some((i) => i.name === 'partial.bin' && i.completedLength > 5e5), null, 15000);
  check('a running download has a partial file and .aria2', fs.existsSync(path.join(dl, 'partial.bin')) && fs.existsSync(path.join(dl, 'partial.bin.aria2')));
  await u.ev(() => window.api.remove((window.__items || []).find((i) => i.name === 'partial.bin').gid));
  await sleep(2500);
  check('Cancel trashes the partial and its .aria2', !fs.existsSync(path.join(dl, 'partial.bin')) && !fs.existsSync(path.join(dl, 'partial.bin.aria2')) && inTrash('partial.bin'), JSON.stringify(fs.readdirSync(dl)));

  // 20. Copied links are offered once, only when they look like downloads
  const offers = [];
  await win.exposeFunction('__offer', (x) => offers.push(x));
  await u.ev(() => window.api.onClipboardLink((x) => window.__offer(x.url)));
  const copyAndFocus = (text) => app.evaluate(({ clipboard, BrowserWindow }, t) => { clipboard.writeText(t); BrowserWindow.getAllWindows()[0].emit('focus'); }, text);
  await copyAndFocus(`${base}/small/copied.zip`);
  await sleep(800);
  check('a copied file link is offered', offers.includes(`${base}/small/copied.zip`) && (await u.ev(() => !document.querySelector('#clip-chip').hidden)), JSON.stringify(offers));
  await copyAndFocus(`${base}/small/copied.zip`);
  await sleep(800);
  check('...only once', offers.filter((x) => x.endsWith('copied.zip')).length === 1);
  await copyAndFocus('https://example.com/news/today');
  await sleep(800);
  check('a copied web page is not offered', !offers.includes('https://example.com/news/today'));
  await u.click('#clip-go');
  await u.waitFor(() => (window.__items || []).some((i) => i.name === 'copied.zip' && i.status === 'complete'), null, 15000).catch(() => {});
  check('one click on the chip downloads it', files().includes('copied.zip'));
  await u.ev(() => window.api.updateSettings({ suggestClipboard: false }));
  await copyAndFocus(`${base}/small/off.zip`);
  await sleep(800);
  check('Settings can turn suggestions off', !offers.some((x) => x.endsWith('off.zip')));
  await u.ev(() => window.api.updateSettings({ suggestClipboard: true }));
  await u.clearAll();

  // 21. DHT is bootstrapped; public trackers (opt-in) go to magnet links only
  const ariaArgs = execFileSync('ps', ['-eo', 'args']).toString().split('\n').find((l) => l.includes(ARIA2C) && l.includes('--enable-rpc')) || '';
  check('aria2 runs with DHT bootstrap nodes and a saved routing table',
    /--enable-dht=true/.test(ariaArgs) && /--enable-dht6=true/.test(ariaArgs) && /--dht-entry-point=router\.bittorrent\.com:6881/.test(ariaArgs) && /--dht-file-path=\S*dht\.dat/.test(ariaArgs),
    ariaArgs.replace(/--rpc-secret=\S+/, '--rpc-secret=…').slice(0, 400));

  // Three separate swarms (different files, so different info hashes): aria2
  // refuses a second download of an info hash it still has registered, which
  // would let one sub-test leak into the next.
  const { startSwarm: startSwarm2, makeTorrent } = require('./lib/swarm');
  const mkSwarm = (name) => startSwarm2({ aria2c: ARIA2C, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dung-swarm2-')), name });
  const swarmOff = await mkSwarm('no-trackers.bin');
  const swarmOn = await mkSwarm('with-trackers.bin');
  const swarmPrivate = await mkSwarm('private.bin');
  const setPublicList = (announces) => {
    for (const dir of [path.join(home, '.config', 'dung'), path.join(home, 'Library', 'Application Support', 'dung'), path.join(home, 'AppData', 'dung')]) {
      fs.writeFileSync(path.join(dir, 'trackers.json'), JSON.stringify({ at: Date.now(), trackers: announces }));
    }
  };
  // aria2 creates the target file (plus a .aria2) as soon as it starts, so
  // "finished" means complete status, full size and no progress file.
  const finished = async (name, size) => (await u.items()).some((i) => i.name === name && i.status === 'complete') && fs.existsSync(path.join(dl, name)) && !fs.existsSync(path.join(dl, `${name}.aria2`)) && fs.statSync(path.join(dl, name)).size === size;
  const bare = (sw, name) => `magnet:?xt=urn:btih:${sw.infoHash}&dn=${name}`;
  try {
    // aria2 announces to extra trackers as a fallback list (first one that
    // answers wins, BEP 12), so each phase's "public list" is the one tracker
    // that phase needs.
    setPublicList([swarmOn.announce]);

    await u.ev(() => window.api.updateSettings({ publicTrackers: false }));
    await u.paste(bare(swarmOff, 'no-trackers.bin'));
    await sleep(12000);
    check('trackerless magnet with public trackers off finds no peers', !(await finished('no-trackers.bin', swarmOff.size)));

    await u.ev(() => window.api.updateSettings({ publicTrackers: true }));
    await u.paste(bare(swarmOn, 'with-trackers.bin'));
    await u.waitFor(() => (window.__items || []).some((i) => i.name === 'with-trackers.bin' && i.status === 'complete'), null, 60000).catch(() => {});
    await sleep(1000);
    check('a trackerless magnet with public trackers on downloads', await finished('with-trackers.bin', swarmOn.size), JSON.stringify((await u.items()).filter((i) => i.torrent).map((i) => `${i.name}:${i.status}`)));

    // A .torrent file (as private trackers hand out) must not get them: its
    // own announce points nowhere, so without public trackers it can't start.
    // Make its seeder's tracker the "public list": if it leaked, it would download.
    setPublicList([swarmPrivate.announce]);
    const deadTorrent = makeTorrent(swarmPrivate.file, 'http://127.0.0.1:9/announce').torrent;
    const torrentServer = await new Promise((resolve) => {
      const srv = http.createServer((req, res) => res.end(deadTorrent)).listen(0, '127.0.0.1', () => resolve(srv));
    });
    await u.paste(`http://127.0.0.1:${torrentServer.address().port}/private.torrent`);
    await sleep(15000);
    const priv = (await u.items()).find((i) => i.torrent && i.name === 'private.bin');
    check('a .torrent file never gets the public trackers', Boolean(priv) && !(await finished('private.bin', swarmPrivate.size)), priv && `${priv.status} ${priv.completedLength}/${priv.totalLength}`);
    torrentServer.close();
  } finally {
    swarmOff.stop();
    swarmOn.stop();
    swarmPrivate.stop();
    await u.ev(() => window.api.updateSettings({ publicTrackers: false }));
  }
  await u.clearAll();
  await sleep(6000); // aria2 saves its session every 5s; let it forget them

  // 14. Restart the app: finished results are old news
  await app.close();
  ({ app, win } = await launch(home));
  await exposeItems(win);
  u = ui(win);
  await sleep(2500);
  check('after relaunch Home is idle or resuming, not replaying finishes', ['idle', 'active'].includes(await u.mode()) && !(await u.ev(() => Boolean(document.querySelector('#stage-actions [data-action="open"]')))), await u.mode());

  await app.close();
  server.close();
  console.log(`\n${results.length - failures}/${results.length} passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
