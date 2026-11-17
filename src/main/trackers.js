'use strict';

/**
 * Optional public BitTorrent trackers (Settings -> Advanced, off by default).
 *
 * When on, magnet links get a list of well-known public trackers added, which
 * helps torrents whose own trackers are dead or missing. Only magnet links:
 * private-tracker torrents come as .torrent files, and announcing those to
 * public trackers would get an account banned.
 *
 * The list is ngosang/trackerslist "best", refreshed every few days and kept
 * in Dung's data folder; a short built-in list covers offline/blocked cases.
 */

const fs = require('node:fs');

const SOURCES = [
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt',
  // Mirror that is often reachable where raw.githubusercontent.com is not.
  'https://cdn.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_best.txt',
];
const MAX_AGE = 3 * 24 * 60 * 60 * 1000;
const MAX_TRACKERS = 20;

const BUILT_IN = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
];

function parseList(text) {
  return [...new Set(String(text || '')
    .split(/\s+/)
    .map((line) => line.trim())
    .filter((line) => /^(udp|https?|wss?):\/\/[^\s,]+$/i.test(line)))].slice(0, MAX_TRACKERS);
}

function netFetch(url, options) {
  try {
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') return net.fetch(url, options);
  } catch {
    /* not in Electron */
  }
  return fetch(url, options);
}

/** Cached list if fresh, else download (first source that works), else stale cache, else built-in. */
async function loadTrackers(cacheFile, { now = Date.now(), onLog = () => {} } = {}) {
  // Tests can point Dung at their own tracker(s).
  if (process.env.DUNG_TRACKERS) return parseList(process.env.DUNG_TRACKERS.replace(/,/g, ' '));

  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    /* none yet */
  }
  if (cached && Array.isArray(cached.trackers) && cached.trackers.length && now - cached.at < MAX_AGE) {
    return cached.trackers;
  }

  for (const source of SOURCES) {
    try {
      const response = await netFetch(source, { headers: { 'user-agent': 'dung' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const trackers = parseList(await response.text());
      if (trackers.length) {
        fs.writeFileSync(cacheFile, JSON.stringify({ at: now, source, trackers }));
        onLog(`[trackers] ${trackers.length} public trackers from ${source}`);
        return trackers;
      }
    } catch (err) {
      onLog(`[trackers] ${source}: ${err.message}`);
    }
  }

  if (cached && Array.isArray(cached.trackers) && cached.trackers.length) return cached.trackers;
  return BUILT_IN;
}

module.exports = { loadTrackers, parseList, BUILT_IN };
