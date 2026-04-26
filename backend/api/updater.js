// GET /api/updater
//
// Tauri auto-updater endpoint. The native app polls this on launch with
// its current version + target triple; we respond with either:
//   - 204 No Content      → user is on latest, nothing to do
//   - 200 + UpdateInfo JSON → there's a newer version; URL + signature returned
//
// Tauri 2.x updater protocol:
//   The app calls: GET /api/updater?target=<triple>&current_version=<semver>
//   We respond JSON: {
//     "version": "0.1.4",
//     "pub_date": "2026-04-25T00:00:00.000Z",
//     "url": "https://github.com/.../releases/download/v0.1.4/Klosr_0.1.4_x64-setup.nsis.zip",
//     "signature": "<base64 signature from TAURI_PRIVATE_KEY>",
//     "notes": "What's new in this version..."
//   }
//
// For v1 we hardcode a manifest. Once GitHub Releases is wired up, this
// reads from the public GH Releases API (no auth needed, just rate-limited).
// Set GITHUB_RELEASES_REPO env var to enable that path
// (e.g. "klosr-hq/klosr-native"). Until set, we return 204.

import { applyCors } from "../lib/cors.js";

// Compare two semver strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
function compareVersions(a, b) {
  const parse = (v) => String(v || "0.0.0").replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0);
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return a1 > b1 ? 1 : -1;
  if (a2 !== b2) return a2 > b2 ? 1 : -1;
  if (a3 !== b3) return a3 > b3 ? 1 : -1;
  return 0;
}

// Map Tauri's target triple → expected installer suffix in GH Releases asset names.
// Tauri-action uploads bundles with predictable filenames; this maps the request
// triple to the right asset.
function assetSuffixForTarget(target) {
  const t = String(target || "").toLowerCase();
  if (t.includes("aarch64-apple-darwin"))      return "aarch64.app.tar.gz";
  if (t.includes("x86_64-apple-darwin"))       return "x64.app.tar.gz";
  if (t.includes("x86_64-pc-windows-msvc"))    return "x64-setup.nsis.zip";
  if (t.includes("aarch64-pc-windows-msvc"))   return "arm64-setup.nsis.zip";
  if (t.includes("x86_64-unknown-linux-gnu"))  return "amd64.AppImage.tar.gz";
  return null;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  // Tauri's HTTP updater is GET-based. We accept GET only.
  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const target = (req.query?.target || "").toString();
  const currentVersion = (req.query?.current_version || "0.0.0").toString();
  const repo = process.env.GITHUB_RELEASES_REPO || ""; // e.g. "klosr-hq/klosr-native"

  // If GitHub Releases isn't wired up yet, return 204 (no update).
  // The native app silently no-ops.
  if (!repo) {
    res.status(204).end();
    return;
  }

  try {
    // Fetch the latest release from GitHub
    const ghRes = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Klosr-Updater/1.0",
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
    });
    if (!ghRes.ok) {
      console.warn("[updater] GH releases API non-ok:", ghRes.status);
      res.status(204).end();
      return;
    }
    const release = await ghRes.json();
    const latestVersion = String(release.tag_name || "0.0.0").replace(/^v/, "");

    // No update if we're already up-to-date or ahead
    if (compareVersions(latestVersion, currentVersion) <= 0) {
      res.status(204).end();
      return;
    }

    // Find the matching installer asset for the target
    const suffix = assetSuffixForTarget(target);
    if (!suffix) {
      res.status(204).end();
      return;
    }
    const asset = (release.assets || []).find(a => a.name?.toLowerCase().endsWith(suffix));
    if (!asset) {
      console.warn(`[updater] no asset for target ${target} (suffix ${suffix}) in v${latestVersion}`);
      res.status(204).end();
      return;
    }

    // Find the .sig signature file alongside it (tauri-action uploads both)
    const sigAsset = (release.assets || []).find(a => a.name?.toLowerCase() === asset.name.toLowerCase() + ".sig");
    let signature = "";
    if (sigAsset) {
      try {
        const sigRes = await fetch(sigAsset.browser_download_url);
        if (sigRes.ok) signature = (await sigRes.text()).trim();
      } catch {/* signature optional in dev; required in production */}
    }

    res.status(200).json({
      version: latestVersion,
      pub_date: release.published_at || new Date().toISOString(),
      url: asset.browser_download_url,
      signature,
      notes: (release.body || "").slice(0, 4000),
    });
  } catch (e) {
    console.warn("[updater]", e && e.message);
    res.status(204).end();
  }
}
