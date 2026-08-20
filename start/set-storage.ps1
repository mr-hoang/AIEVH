param(
    [string]$StorageRoot
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$repo = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
if ([string]::IsNullOrWhiteSpace($StorageRoot)) {
    Write-Host ""
    Write-Host "  AIEV vẫn chạy ở ổ hiện tại; dữ liệu nặng sẽ chuyển sang thư mục bạn chọn." -ForegroundColor Cyan
    Write-Host "  Gợi ý: D:\AIEV-Data" -ForegroundColor DarkGray
    $StorageRoot = Read-Host "  Nhập nơi lưu dữ liệu"
}

$StorageRoot = [Environment]::ExpandEnvironmentVariables($StorageRoot.Trim().Trim('"'))
if (-not [IO.Path]::IsPathRooted($StorageRoot)) {
    throw "Phải nhập đường dẫn tuyệt đối, ví dụ D:\AIEV-Data"
}

$storage = [IO.Path]::GetFullPath($StorageRoot).TrimEnd('\', '/')
$driveRoot = [IO.Path]::GetPathRoot($storage)
if (-not $driveRoot -or -not (Test-Path -LiteralPath $driveRoot)) {
    throw "Ổ đĩa không tồn tại hoặc chưa sẵn sàng: $driveRoot"
}
$repoPrefix = $repo.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if ($storage.Equals($repo, [StringComparison]::OrdinalIgnoreCase) -or
    $storage.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Nơi lưu phải nằm ngoài thư mục ứng dụng. Ví dụ đúng: D:\AIEV-Data"
}

$mappings = @(
    @{ Relative = "video-projects"; Target = "video-projects" },
    @{ Relative = "image-projects"; Target = "image-projects" },
    @{ Relative = "auto-cut"; Target = "auto-cut" },
    @{ Relative = "text-to-video"; Target = "text-to-video" },
    @{ Relative = "translate-video"; Target = "translate-video" },
    @{ Relative = "outputs"; Target = "outputs" },
    @{ Relative = "imports"; Target = "imports" },
    @{ Relative = ".runtime"; Target = "runtime" },
    @{ Relative = "engines\remotion\public\staging"; Target = "remotion-staging" }
)

New-Item -ItemType Directory -Force -Path $storage | Out-Null
$plan = @()

# Preflight toàn bộ trước khi di chuyển file: gặp xung đột thì dừng mà chưa đổi gì.
foreach ($mapping in $mappings) {
    $source = [IO.Path]::GetFullPath((Join-Path $repo $mapping.Relative))
    $target = [IO.Path]::GetFullPath((Join-Path $storage $mapping.Target))
    $storagePrefix = $storage + [IO.Path]::DirectorySeparatorChar
    if (-not $target.StartsWith($storagePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Đường dẫn đích không an toàn: $target"
    }
    New-Item -ItemType Directory -Force -Path $target | Out-Null

    $alreadyLinked = $false
    if (Test-Path -LiteralPath $source) {
        $sourceItem = Get-Item -Force -LiteralPath $source
        if (($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $linkTarget = @($sourceItem.Target)[0]
            if ($linkTarget) {
                $linkTarget = [IO.Path]::GetFullPath($linkTarget).TrimEnd('\', '/')
            }
            if (-not $linkTarget -or -not $linkTarget.Equals($target, [StringComparison]::OrdinalIgnoreCase)) {
                throw "$source đã là liên kết tới nơi khác. Không tự ghi đè để tránh mất dữ liệu."
            }
            $alreadyLinked = $true
        } else {
            foreach ($child in Get-ChildItem -Force -LiteralPath $source) {
                $collision = Join-Path $target $child.Name
                if (Test-Path -LiteralPath $collision) {
                    throw "Trùng dữ liệu tại $collision. Hãy chọn thư mục D: trống hoặc tự hợp nhất trước."
                }
            }
        }
    }
    $plan += @{ Source = $source; Target = $target; Linked = $alreadyLinked }
}

foreach ($item in $plan) {
    if ($item.Linked) {
        Write-Host "  [OK] Đã liên kết: $($item.Source)" -ForegroundColor Green
        continue
    }
    if (Test-Path -LiteralPath $item.Source) {
        Get-ChildItem -Force -LiteralPath $item.Source | ForEach-Object {
            Move-Item -LiteralPath $_.FullName -Destination $item.Target
        }
        Remove-Item -LiteralPath $item.Source -Force
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $item.Source) | Out-Null
    }
    New-Item -ItemType Junction -Path $item.Source -Target $item.Target | Out-Null
    Write-Host "  [OK] $($item.Source) -> $($item.Target)" -ForegroundColor Green
}

$stateDir = Join-Path $repo ".aiev"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
@{
    storageRoot = $storage
    configuredAt = (Get-Date).ToString("o")
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDir "storage.json") -Encoding UTF8

Write-Host ""
Write-Host "  Hoàn tất. App vẫn ở: $repo" -ForegroundColor Green
Write-Host "  Video, project, output và cache nặng ở: $storage" -ForegroundColor Green
Write-Host "  Bây giờ chạy lại start.bat." -ForegroundColor Cyan
