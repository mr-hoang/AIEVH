# AIEV Local Studio - dừng toàn bộ hệ thống (web 6868 + server 6869)

$ErrorActionPreference = "SilentlyContinue"
$killed = 0
$failed = 0

foreach ($port in 6868, 6869) {
    $pids = @(Get-NetTCPConnection -LocalPort $port -State Listen |
        Select-Object -ExpandProperty OwningProcess -Unique)
    # Một số bản Windows trả Access denied/không có kết quả cho
    # Get-NetTCPConnection dù netstat vẫn thấy cổng. Dùng netstat làm fallback
    # để stop.bat không bỏ sót process Node cũ giữ cổng.
    if ($pids.Count -eq 0) {
        $pattern = "^\s*TCP\s+\S+:${port}\s+\S+\s+LISTENING\s+(\d+)\s*$"
        $pids = @(& netstat -ano -p tcp | ForEach-Object {
            if ($_ -match $pattern) { [int]$Matches[1] }
        } | Sort-Object -Unique)
    }
    foreach ($procId in $pids) {
        if ($procId -and $procId -ne 0) {
            # Kill cả cây process (node + con của nó)
            taskkill /pid $procId /t /f 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { $killed++ } else { $failed++ }
        }
    }
}

# Xóa dấu vết "đang chạy" để lần bấm start sau không nhận nhầm trạng thái cũ.
Remove-Item (Join-Path (Split-Path -Parent $PSScriptRoot) ".aiev\run.json") -ErrorAction SilentlyContinue

if ($killed -gt 0) {
    Write-Host "  [OK] Đã dừng AIEV Local Studio ($killed process)." -ForegroundColor Green
} elseif ($failed -gt 0) {
    Write-Host "  [LOI] Không đủ quyền dừng AIEV. Hãy chuột phải stop.bat và chọn Run as administrator." -ForegroundColor Red
} else {
    Write-Host "  Hệ thống không chạy - không có gì để dừng." -ForegroundColor DarkGray
}
