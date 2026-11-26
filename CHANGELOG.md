# Changelog

## 1.8.2 — Video links just work

### Fixed
- **"yt-dlp not found" on the first video link** (Pinterest, YouTube, X…). Dung now fetches its free video helper automatically the first time you paste a video page, then carries on with the download — no error, no extra button.

## 1.8.1 — Better at finding peers

### New
- **Magnet links without trackers now start.** Dung joins the BitTorrent DHT properly (well-known bootstrap nodes, IPv4 and IPv6, and it remembers what it learns), so a bare `magnet:?xt=urn:btih:…` can find peers instead of sitting on *sniffing it out…*.
- **Pinterest videos.** Pinterest pins (any country domain, and `pin.it` short links) are recognised as a video site: they go straight to video support and a copied pin is offered with one click.
- **Optional public trackers** (Settings → Advanced → *Find more peers with public trackers*, off by default). Adds a well-known public tracker list to **magnet links** when their own trackers are missing or dead. Never added to `.torrent` files, so private trackers stay safe. The list is refreshed every few days, with a built-in fallback.

## 1.8.0 — Tidier finishes

### New
- **Average speed in History.** Each finished file shows how fast it came in and for how long, e.g. *avg 18.2 MB/s · 5m 12s* — counting only the time it was actually downloading, so pausing doesn't drag the number down.
- **Copied a download link? Dung offers it.** When you switch to Dung, a link you just copied (a magnet, a file like .zip/.dmg/.pdf, or a video page Dung supports) shows up under the paste box — one click to download. Each link is offered once, Dung never reads your clipboard in the background, and you can turn it off in Settings.
- **Move to Trash.** Finished files now have **Move to Trash** (with **Undo** for a few seconds), clearly separate from **✕ Remove from list**, which keeps the file.
- **Cancel cleans up.** Cancelling a download moves its half-downloaded file to the Trash instead of leaving it in your folder.

### Fixed
- **Deleted or moved a downloaded file in Finder/Explorer?** Dung now notices. The finish screen and History mark it *wandered off* and offer **Download again**, instead of an Open button that silently did nothing.
- **Open / Show in folder** on a file that's gone now say so (Show in folder opens its folder instead).
- If the downloaded update was removed before you pressed **Restart to update**, Dung fetches it again instead of doing nothing.
- **Magnet links finish properly.** A finished torrent used to sit at 100% saying *rolling* at 0 B/s, because it kept seeding. Dung now stops when the download is done and says *rolled home*.
- The "[METADATA]" step of a magnet link no longer shows up as its own download; it reads *sniffing it out…* until the real download starts.
- Multi-file torrents show the torrent's name, and Open / Show in folder go to its folder.
- Pasting the same torrent again — even as a differently written magnet link — is recognised (*already rolling* / *you already have it*).

## 1.7.0 — Updates in one click

### New
- **Restart to update.** When there's a new version, Dung downloads it quietly in the background. Once it's ready you get one button — **Restart to update** — and Dung swaps itself for the new version and reopens. No DMG to drag, no installer to click through.
- **Update from Settings directly.** "Check for updates" now offers the same button right there, so you don't have to close Settings to act on it.

### Notes
- Updates still come straight from GitHub and go through your system proxy. If Dung can't install in place (for example the Windows portable version, or an app you can't write to), it opens the installer or the release page instead.

## 1.6.2 — Update checks that don't hit a wall

### Fixed
- **"Update check failed: GitHub API responded 403" is gone.** GitHub's API allows only 60 checks an hour per network, and shared networks (offices, proxies, VPNs) run out fast. When that happens Dung now asks GitHub's regular release page instead, which has no such limit — so it still finds the new version and downloads it.

> On 1.6.0 or 1.6.1 and seeing that 403? Download 1.6.2 from the release page once; checks work from here on.

## 1.6.1 — Updates that actually download

### Fixed
- **The Download button on the update banner works behind a proxy.** Update checks and downloads now go through your system proxy (Clash, Surge, a company proxy…) just like your browser does, so they work where GitHub is only reachable through one.
- **When an update can't download, Dung says why** — and offers **Open in browser** instead of quietly doing nothing.
- A failed background check no longer makes a visible update banner forget its installer.
- Update downloads give up after 30 seconds without data instead of hanging, and never leave a half-downloaded installer behind.

### Also
- Dung now lives at **github.com/xfanwu/dung** (the old address redirects), with a new home page at **xfanwu.github.io/dung**.

> If you are on 1.6.0 or older and the update banner's Download does nothing, grab 1.6.1 from the release page once — updates work from here on.

## 1.6.0 — Paste a link. It downloads.

Dung is rebuilt around one move, for people who have never used a download manager.

### New
- **Just paste.** Press ⌘V / Ctrl+V anywhere in the window, or drop a link on it — the download starts by itself.
- **Nothing to install.** The downloader (aria2 1.37) now ships inside the app. No Homebrew, no setup.
- **Several at once.** Each download gets its own little beetle lane; finished ones dance, then fold away.
- **History behind a sliding door.** Pull the list tab on the right edge (or ⌘]) and your past downloads slide in.
- **A finish screen that waits for you,** with Open and Show in folder.
- **You already have it?** Dung tells you, with Show file — or Download again, saved alongside.
- **Dung language:** downloads are *rolling*, queued ones wait *in line*, finished ones are *rolled home*.
- **New look:** black on white with the colourful pixel beetle, a pixel wordmark, and a golden pixel-dung app icon.
- **Simpler Settings:** where files go, a speed limit that understands "5 MB/s", and the rest tucked under Advanced.

### Fixed
- Dung could **overwrite a file of yours** that happened to share a download's name. It now asks: Cancel, Keep Both or Overwrite.
- Pasting the same link twice no longer starts a second copy (or risks deleting the one in progress).
- The finish screen sometimes showed the wrong file, flashed back to the start, or the beetle rolled backwards.
- Videos no longer need `brew install ffmpeg`.
- The page no longer jumps when a message appears; many smaller fixes from end-to-end testing.

### Under the hood
- Developer tools are off in release builds (`DUNG_DEVTOOLS=1` to debug).
- New test workflow: a real-app end-to-end suite runs on every change.
- aria2 is GPL-2.0-or-later; its licence ships in the app and its source is attached to this release.
