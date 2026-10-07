# Chrome 操作助手 · Windows 安装脚本
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -useb https://dl.linbingbing.asia/browser-bridge/install.ps1 | iex"
# 幂等：已安装时重复执行只会刷新版本与命令转发，不会重复注册。
$ErrorActionPreference = 'Stop'

$Base      = 'https://dl.linbingbing.asia/browser-bridge'
$Fallback  = 'https://github.com/linshenghan/browser-bridge/releases/download'
$GUIDE     = 'https://install.linbingbing.asia'
$Version   = if ($env:TBB_VERSION) { $env:TBB_VERSION } else { '0.2.1' }
$Root      = Join-Path $env:USERPROFILE 'BrowserBridge'
$Zip       = "browser-bridge-v$Version-windows-x64.zip"
$Tmp       = Join-Path $env:TEMP ("tbb-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))

function Write-Step($msg) { Write-Host "▸ $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "错误：$msg" -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Path $Tmp -Force | Out-Null
try {
    Write-Step "下载 $Zip"
    try {
        Invoke-WebRequest -Uri "$Base/v$Version/$Zip" -OutFile "$Tmp\$Zip" -TimeoutSec 300 -UseBasicParsing
    } catch {
        Write-Host "  主源不可用，改用备用源" -ForegroundColor Yellow
        try {
            Invoke-WebRequest -Uri "$Fallback/v$Version/$Zip" -OutFile "$Tmp\$Zip" -TimeoutSec 300 -UseBasicParsing
        } catch { Fail '下载失败，请检查网络后重试。' }
    }

    Write-Step '校验完整性'
    try {
        Invoke-WebRequest -Uri "$Base/v$Version/SHA256SUMS.txt" -OutFile "$Tmp\SHA256SUMS.txt" -TimeoutSec 30 -UseBasicParsing
        $expect = (Get-Content "$Tmp\SHA256SUMS.txt" | Where-Object { $_ -match "\s$Zip$" }) -split '\s+' | Select-Object -First 1
        if ($expect) {
            $actual = (Get-FileHash -Algorithm SHA256 "$Tmp\$Zip").Hash
            if ($expect.ToUpper() -ne $actual.ToUpper()) {
                Fail "文件校验不匹配，已中止。预期 $expect，实际 $actual。"
            }
            Write-Host '  校验通过' -ForegroundColor Green
        }
    } catch { Write-Host '  跳过校验（未获取到校验文件）' -ForegroundColor Yellow }

    Write-Step '解压'
    Expand-Archive -Path "$Tmp\$Zip" -DestinationPath "$Tmp\pkg" -Force
    $exe = Get-ChildItem -Path "$Tmp\pkg" -Filter 'browser-bridge.exe' -Recurse | Select-Object -First 1
    if (-not $exe) { Fail '压缩包内容异常，未找到主程序。' }

    Write-Step '注册浏览器组件'
    & $exe.FullName install --source $exe.DirectoryName | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail '注册失败，请查看上方输出。' }

    Write-Step '写入命令路径'
    $instPath = Join-Path $Root 'installation.json'
    if (-not (Test-Path $instPath)) { Fail "未找到安装记录：$instPath" }
    $inst = Get-Content $instPath -Raw | ConvertFrom-Json
    $real = Join-Path $inst.current 'browser-bridge.exe'
    if (-not (Test-Path $real)) { Fail "未找到主程序：$real" }

    $shimDir = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
    if (-not (Test-Path $shimDir)) {
        $shimDir = Join-Path $env:USERPROFILE '.local\bin'
        New-Item -ItemType Directory -Path $shimDir -Force | Out-Null
    }
    $shim = Join-Path $shimDir 'browser-bridge.cmd'
    [System.IO.File]::WriteAllText($shim, "@echo off`r`nchcp 65001 >nul`r`n`"$real`" %*", (New-Object System.Text.UTF8Encoding $false))
    Write-Host "  已写入命令转发：$shim" -ForegroundColor Green

    Write-Host ''
    Write-Host "本机程序安装完成（v$Version）" -ForegroundColor Green
    Write-Host '还剩最后一步，需要你在 Chrome 里点两下：' -ForegroundColor Yellow
    Write-Host '  1. 打开 chrome://extensions，开启右上角「开发者模式」'
    Write-Host "  2. 点「加载已解压的扩展程序」，选择 $Root\extension"
    Write-Host ''
    Write-Host "图文指引：$GUIDE"
} finally {
    Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
