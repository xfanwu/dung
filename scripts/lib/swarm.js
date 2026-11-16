'use strict';

/**
 * A tiny local BitTorrent swarm for tests: makes a torrent for a file, runs
 * a minimal HTTP tracker and seeds the file with a separate aria2c, so a
 * magnet link can be downloaded end to end without the internet.
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

function bencode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === 'string') return bencode(Buffer.from(value));
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')]);
  const keys = Object.keys(value).sort();
  return Buffer.concat([Buffer.from('d'), ...keys.flatMap((k) => [bencode(k), bencode(value[k])]), Buffer.from('e')]);
}

function makeTorrent(file, announce, pieceLength = 256 * 1024) {
  const data = fs.readFileSync(file);
  const pieces = [];
  for (let i = 0; i < data.length; i += pieceLength) {
    pieces.push(crypto.createHash('sha1').update(data.subarray(i, i + pieceLength)).digest());
  }
  const info = { length: data.length, name: path.basename(file), 'piece length': pieceLength, pieces: Buffer.concat(pieces) };
  const infoHash = crypto.createHash('sha1').update(bencode(info)).digest('hex');
  return { torrent: bencode({ announce, info }), infoHash };
}

function startTracker() {
  const peers = new Map(); // "ip:port" -> Buffer(6)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const port = Number(url.searchParams.get('port'));
    if (port) {
      const ip = '127.0.0.1';
      const entry = Buffer.alloc(6);
      ip.split('.').forEach((n, i) => entry.writeUInt8(Number(n), i));
      entry.writeUInt16BE(port, 4);
      peers.set(`${ip}:${port}`, entry);
    }
    res.end(bencode({ interval: 5, peers: Buffer.concat([...peers.values()]) }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Seeds `file` (in its folder) with its own aria2c. Returns the child. */
function seed(aria2c, torrentFile, dir, listenPort) {
  return spawn(aria2c, [
    '--no-conf=true',
    `--dir=${dir}`,
    `--listen-port=${listenPort}`,
    '--enable-dht=false',
    '--bt-enable-lpd=false',
    '--enable-peer-exchange=false',
    '--check-integrity=true',
    '--seed-ratio=0.0',
    '--bt-seed-unverified=false',
    '--console-log-level=warn',
    '--summary-interval=0',
    torrentFile,
  ], { stdio: 'ignore' });
}

async function startSwarm({ aria2c, workDir, size = 3 * 1024 * 1024, name = 'swarm-file.bin' }) {
  const seedDir = path.join(workDir, 'seed');
  fs.mkdirSync(seedDir, { recursive: true });
  const file = path.join(seedDir, name);
  fs.writeFileSync(file, crypto.randomBytes(size));
  const tracker = await startTracker();
  const announce = `http://127.0.0.1:${tracker.address().port}/announce`;
  const { torrent, infoHash } = makeTorrent(file, announce);
  const torrentFile = path.join(workDir, `${name}.torrent`);
  fs.writeFileSync(torrentFile, torrent);
  const seeder = seed(aria2c, torrentFile, seedDir, 20000 + Math.floor(Math.random() * 20000));
  const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}&tr=${encodeURIComponent(announce)}`;
  return {
    magnet,
    infoHash,
    file,
    size,
    stop() {
      seeder.kill('SIGKILL');
      tracker.close();
    },
  };
}

module.exports = { startSwarm, bencode, makeTorrent };
