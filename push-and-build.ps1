# Klosr — one-command setup: GitHub auth → push → tag → trigger Mac build
#
# Usage:
#   1. Open PowerShell
#   2. cd C:\Users\bosco\Downloads\klosr
#   3. .\push-and-build.ps1
#
# What it does:
#   - Authenticates gh CLI (interactive: paste device code in browser)
#   - Creates a private GitHub repo named "klosr-app"
#   - Pushes the current main branch
#   - Tags v0.3.5 → triggers .github/workflows/release.yml
#   - GitHub Actions builds Mac DMG (Apple Silicon + Intel), Windows MSI/EXE,
#     Linux .deb/.AppImage on their respective runners (~15-20 min total)
#   - Artifacts publish to https://github.com/<you>/klosr-app/releases

$ErrorActionPreference = "Stop"
$gh = "C:\Program Files\GitHub CLI\gh.exe"
if (-not (Test-Path $gh)) { Write-Error "gh CLI not found at $gh"; exit 1 }

Write-Host "===== Klosr GitHub setup =====" -ForegroundColor Yellow

# 1. Auth check
Write-Host "`n[1/5] Checking GitHub auth..." -ForegroundColor Cyan
$authed = & $gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Not logged in. Starting browser auth..." -ForegroundColor Yellow
    Write-Host "When prompted: paste the 8-char code into the browser, then return here." -ForegroundColor Yellow
    & $gh auth login --hostname github.com --git-protocol https --web
    if ($LASTEXITCODE -ne 0) { Write-Error "gh auth login failed"; exit 1 }
} else {
    Write-Host "Already authenticated:" -ForegroundColor Green
    Write-Host $authed
}

# Capture username for the rest of the flow
$user = & $gh api user --jq ".login" 2>&1
if ($LASTEXITCODE -ne 0) { Write-Error "Could not read GitHub user"; exit 1 }
Write-Host "Logged in as: $user" -ForegroundColor Green

# 2. Create repo (private by default — switch to --public if you want)
$repo = "klosr-app"
Write-Host "`n[2/5] Creating private repo $user/$repo (skipping if it exists)..." -ForegroundColor Cyan
$exists = & $gh repo view "$user/$repo" --json name 2>&1
if ($LASTEXITCODE -ne 0) {
    & $gh repo create "$user/$repo" --private --description "Klosr — Sales OS for founders" --homepage "https://klosr.com"
    if ($LASTEXITCODE -ne 0) { Write-Error "repo create failed"; exit 1 }
    Write-Host "Created $user/$repo" -ForegroundColor Green
} else {
    Write-Host "Repo $user/$repo already exists — skipping creation" -ForegroundColor Green
}

# 3. Wire the remote (replace any existing)
Write-Host "`n[3/5] Wiring git remote..." -ForegroundColor Cyan
git remote remove origin 2>&1 | Out-Null
git remote add origin "https://github.com/$user/$repo.git"
Write-Host "Remote set: https://github.com/$user/$repo.git" -ForegroundColor Green

# 4. Push main
Write-Host "`n[4/5] Pushing main branch (this is the big one — ~40K lines, may take a min)..." -ForegroundColor Cyan
git push -u origin main
if ($LASTEXITCODE -ne 0) { Write-Error "git push failed"; exit 1 }
Write-Host "Pushed main" -ForegroundColor Green

# 5. Tag v0.3.5 → triggers Actions release workflow
Write-Host "`n[5/5] Tagging v0.3.5 to trigger the Mac/Win/Linux release build..." -ForegroundColor Cyan
$existingTag = git tag --list "v0.3.5"
if ($existingTag) {
    Write-Host "Tag v0.3.5 already exists locally — pushing to remote" -ForegroundColor Yellow
} else {
    git tag -a v0.3.5 -m "Klosr v0.3.5 — Cluely-style main app + auth-code dev mode + paste fix"
    Write-Host "Created local tag v0.3.5" -ForegroundColor Green
}
git push origin v0.3.5
if ($LASTEXITCODE -ne 0) { Write-Error "git push tag failed"; exit 1 }
Write-Host "Pushed v0.3.5 — Actions workflow triggered" -ForegroundColor Green

# Done!
Write-Host "`n===== DONE =====" -ForegroundColor Green
Write-Host "Watch the build live:" -ForegroundColor Yellow
Write-Host "  https://github.com/$user/$repo/actions" -ForegroundColor White
Write-Host "`nDownload Mac DMG when build finishes (~15-20 min):" -ForegroundColor Yellow
Write-Host "  https://github.com/$user/$repo/releases/tag/v0.3.5" -ForegroundColor White
Write-Host ""
Write-Host "Tip: open the Actions tab now in your browser. The 5 platforms build in parallel:" -ForegroundColor Cyan
Write-Host "  - macOS Apple Silicon (aarch64-apple-darwin) -> .dmg"
Write-Host "  - macOS Intel (x86_64-apple-darwin)         -> .dmg"
Write-Host "  - Windows x64                               -> .msi + .exe"
Write-Host "  - Windows ARM64                             -> .msi + .exe"
Write-Host "  - Linux x64                                 -> .deb + .AppImage"
