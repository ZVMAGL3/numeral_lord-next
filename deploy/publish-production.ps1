#Requires -Version 7.0
<#
.SYNOPSIS
Validates, pushes, and deploys the current main commit to production.
.EXAMPLE
pwsh -File deploy/publish-production.ps1
.EXAMPLE
pwsh -File deploy/publish-production.ps1 -ValidateOnly
#>
[CmdletBinding()]
param(
    [switch]$ValidateOnly,
    [string]$IdentityFile = (Join-Path $HOME '.ssh/numeral_lord_deploy_rsa'),
    [string]$KnownHostsFile = (Join-Path $HOME '.ssh/numeral_lord_known_hosts')
)

$ErrorActionPreference = 'Stop'

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)

    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Program failed with exit code $LASTEXITCODE."
    }
}

$originalPath = $env:Path
$originalEndpoint = $env:PVP_SMOKE_ENDPOINT
$originalResetCheck = $env:PVP_SMOKE_CHECK_RESET
$archive = $null
$downloadedIndex = $null
Push-Location (Join-Path $PSScriptRoot '..')
try {
    if ((Invoke-Checked git @('branch', '--show-current')) -cne 'main') {
        throw 'Check out main before publishing.'
    }
    if (Invoke-Checked git @('status', '--porcelain')) {
        throw 'Commit or set aside local changes before publishing.'
    }
    $commit = Invoke-Checked git @('rev-parse', '--verify', 'HEAD')
    $shortCommit = $commit.Substring(0, 7)

    $node = Get-Command node.exe -CommandType Application -All |
        Where-Object { [int](& $_.Source -p 'process.versions.node.split(".")[0]') -ge 24 } |
        Select-Object -First 1 -ExpandProperty Source
    if (-not $node) {
        throw 'Node.js 24 or later must be available on PATH.'
    }
    $env:Path = (Split-Path $node) + ';' + $env:Path
    $pnpmVersion = (Get-Content -Raw package.json | ConvertFrom-Json).packageManager -replace '^pnpm@', ''
    $pnpm = Join-Path (Get-Location) "node_modules/.cache/corepack/pnpm/$pnpmVersion/pnpm-native.exe"
    $pnpmPrefix = @()
    if (-not (Test-Path -LiteralPath $pnpm -PathType Leaf)) {
        $pnpm = 'corepack.cmd'
        $pnpmPrefix = @('pnpm')
    }

    Write-Host "Validating $shortCommit"
    Invoke-Checked $pnpm ($pnpmPrefix + @('install', '--frozen-lockfile', '--store-dir', 'node_modules/.cache/pnpm-store'))
    Invoke-Checked $pnpm ($pnpmPrefix + @('--filter', '@numeral-lord/game-core', 'build'))
    Invoke-Checked $pnpm ($pnpmPrefix + @('typecheck'))
    Invoke-Checked $pnpm ($pnpmPrefix + @('test'))
    Invoke-Checked $pnpm ($pnpmPrefix + @('--filter', '@numeral-lord/web', 'build:deploy'))
    if (-not ((Test-Path apps/web/dist/index.html) -and (Test-Path apps/web/dist/legacy/TS0.png))) {
        throw 'Production build outputs are missing.'
    }

    $releaseId = "$shortCommit-$([Guid]::NewGuid().ToString('N'))"
    $cache = (New-Item -Force -ItemType Directory node_modules/.cache/numeral-lord).FullName
    $archive = Join-Path $cache "production-$releaseId.tar.gz"
    Invoke-Checked git @('archive', '--format=tar.gz', "--output=$archive", $commit, '--',
        'apps', 'packages', 'deploy', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json')
    $paths = Invoke-Checked tar.exe @('-tzf', $archive)
    $excluded = '(?i)(^|/)(\.git|node_modules|dist|\.cache|\.ssh|\.env(?:\.[^/]*)?|[^/]+\.(?:sqlite\d*|db)(?:-(?:wal|shm|journal))?|[^/]+\.(?:pem|key|pfx|p12)|[^/]*deploy_rsa)(/|$)|^apps/server/data/'
    if (($paths -match $excluded) -or ('deploy/update-production.sh' -cnotin $paths)) {
        throw 'The release archive contains excluded files or lacks the deploy script.'
    }
    if ($ValidateOnly) {
        Write-Host "Validation and release packaging passed for $shortCommit."
        return
    }

    if (-not ((Test-Path -LiteralPath $IdentityFile -PathType Leaf) -and
        (Test-Path -LiteralPath $KnownHostsFile -PathType Leaf))) {
        throw 'The deployment RSA identity and verified known_hosts file are required.'
    }
    $github = 'https://github.com/ZVMAGL3/numeral_lord-next.git'
    if ((Invoke-Checked git @('remote', 'get-url', '--push', 'origin')) -cne $github) {
        throw 'The origin push URL does not match the project repository.'
    }
    Write-Host "Pushing $shortCommit to origin/main"
    Invoke-Checked git @('-c', 'credential.helper=', '-c', 'credential.helper=manager',
        '-c', 'credential.gitHubAuthModes=browser', 'push', 'origin', "${commit}:refs/heads/main")
    $remoteRef = Invoke-Checked git @('ls-remote', '--exit-code', $github, 'refs/heads/main')
    if (($remoteRef -split '\s+')[0] -cne $commit) {
        throw 'GitHub main does not point to the validated commit.'
    }

    $hostIp = '39.107.250.161'
    $server = "root@$hostIp"
    $ssh = @('-i', (Resolve-Path -LiteralPath $IdentityFile).Path,
        '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', "UserKnownHostsFile=$((Resolve-Path -LiteralPath $KnownHostsFile).Path)",
        '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15')
    $upload = "/tmp/numeral-lord-next-production-$releaseId.tar.gz.part"
    $checksum = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host "Uploading and deploying $shortCommit"
    Invoke-Checked scp.exe ($ssh + @($archive, "${server}:$upload"))

    $remoteCommand = @'
set -euo pipefail
upload=__UPLOAD__
archive=/tmp/numeral-lord-next-production.tar.gz
cleanup() {
  if [[ "$archive" -ef "$upload" ]]; then rm -f -- "$archive"; fi
  rm -f -- "$upload"
}
trap cleanup EXIT
printf '%s  %s\n' '__CHECKSUM__' "$upload" | sha256sum -c -
ln -T -- "$upload" "$archive"
tar -xOzf "$archive" deploy/update-production.sh | env ALLOW_ACTIVE_CONNECTIONS=1 bash
systemctl is-active numeral-lord.service
printf 'RELEASE_INDEX_SHA256=%s\n' "$(sha256sum /opt/numeral-lord-next/apps/web/dist/index.html | cut -d ' ' -f 1)"
'@
    $remoteCommand = $remoteCommand.Replace('__UPLOAD__', $upload).Replace('__CHECKSUM__', $checksum) -replace "`r`n", "`n"
    Invoke-Checked ssh.exe ($ssh + @($server, $remoteCommand)) | Tee-Object -Variable deploymentLog | Out-Host
    $indexHash = ($deploymentLog | Where-Object { $_ -match '^RELEASE_INDEX_SHA256=[a-f0-9]{64}$' }) -replace '^RELEASE_INDEX_SHA256='
    if (-not $indexHash) {
        throw 'The server did not return the deployed index checksum.'
    }

    Write-Host 'Checking the live site and relay'
    $site = "http://$hostIp"
    $base = '/numeral-lord-play/'
    $downloadedIndex = Join-Path $cache "production-$releaseId.html"
    $curl = @('--fail', '--silent', '--show-error', '--connect-timeout', '8', '--max-time', '20')
    Invoke-Checked curl.exe ($curl + @('--output', $downloadedIndex, "$site$base"))
    if ((Get-FileHash -LiteralPath $downloadedIndex -Algorithm SHA256).Hash.ToLowerInvariant() -cne $indexHash) {
        throw 'The public homepage does not match the deployed build.'
    }
    $html = Get-Content -Raw -LiteralPath $downloadedIndex
    $assets = [regex]::Matches($html, '(?<=["''])/numeral-lord-play/assets/[^"'']+\.(?:js|css)') |
        ForEach-Object Value | Sort-Object -Unique
    if (-not ($assets -match '\.js$') -or -not ($assets -match '\.css$')) {
        throw 'The public homepage does not reference its JavaScript and CSS.'
    }
    foreach ($path in @("${base}rooms", "${base}legacy/TS0.png", '/numeral-lord/') + $assets) {
        $status = Invoke-Checked curl.exe ($curl + @('--output', 'NUL', '--write-out', '%{http_code}', "$site$path"))
        if ($status -ne '200') {
            throw "Expected HTTP 200 for $path, got $status."
        }
        Write-Host "HTTP $status $path"
    }
    $env:PVP_SMOKE_ENDPOINT = "ws://$hostIp/numeral-lord"
    $env:PVP_SMOKE_CHECK_RESET = '1'
    Invoke-Checked $node @('apps/web/scripts/public-pvp-smoke.mjs')
    Write-Host "Published $shortCommit to $site$base"
}
finally {
    foreach ($file in @($archive, $downloadedIndex)) {
        if ($file -and (Test-Path -LiteralPath $file)) {
            Remove-Item -LiteralPath $file
        }
    }
    $env:Path = $originalPath
    $env:PVP_SMOKE_ENDPOINT = $originalEndpoint
    $env:PVP_SMOKE_CHECK_RESET = $originalResetCheck
    Pop-Location
}
