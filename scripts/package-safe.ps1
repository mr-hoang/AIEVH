$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseRoot = Join-Path $repo 'release'
$stage = Join-Path $releaseRoot 'AIEV-Local-Studio'
$zip = Join-Path $releaseRoot 'AIEV-Local-Studio.zip'

if (-not $releaseRoot.StartsWith($repo, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe release path: $releaseRoot"
}

New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# Tracked + source mới chưa commit, nhưng tuyệt đối không lấy file bị .gitignore
# (các vùng đó chứa key, DB, project, logo/giọng người dùng và output render).
$files = & git -C $repo ls-files --cached --others --exclude-standard
if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed' }

$deny = @(
  '.env',
  'apps/server/data/',
  'outputs/',
  'imports/',
  'video-projects/',
  'image-projects/',
  'auto-cut/',
  'text-to-video/',
  'translate-video/',
  '.runtime/',
  '.aiev/',
  'release/'
)

foreach ($relative in $files) {
  $normalized = $relative.Replace('\', '/')
  $blocked = $false
  foreach ($prefix in $deny) {
    $isDirectory = $prefix.EndsWith('/')
    if ($normalized -eq $prefix.TrimEnd('/') -or ($isDirectory -and $normalized.StartsWith($prefix))) {
      $blocked = $true
      break
    }
  }
  if ($blocked) { continue }
  $source = Join-Path $repo $relative
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
  $target = Join-Path $stage $relative
  $parent = Split-Path -Parent $target
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Force
}

Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
Remove-Item -LiteralPath $stage -Recurse -Force

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $zip
Write-Output "SAFE_ZIP=$zip"
Write-Output "SHA256=$($hash.Hash)"
