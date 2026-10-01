<#
  install.ps1 —— 从 GitHub 取回 dsh-remote-access-cidr，放到一个固定目录，然后**由 DSH 自己**完成安装。

  为什么脚本不替你把插件"装上"：DSH 的插件安装（写 profile 的 package.json / cordis.patch.yml、
  跑包管理器）只能由 DSH 自己做 —— 设置页的「添加插件」，或者让 agent 用 plugin_manager 工具。
  手工去改 profile 属于踩红线，容易把 profile 弄坏。所以这里只做「把代码取到本机」这一步，
  取完把目录打印出来，你把它填进插件页即可。

  用法（任选一种）：

    # A. 直接跑（会下载到 %LOCALAPPDATA%\dsh-plugins\dsh-remote-access-cidr）
    irm https://raw.githubusercontent.com/Mzy123l/dsh-remote-access-cidr/main/install.ps1 | iex

    # B. 带参数（需要代理 / 想换目录或仓库）
    $s = irm https://raw.githubusercontent.com/Mzy123l/dsh-remote-access-cidr/main/install.ps1
    & ([scriptblock]::Create($s)) -Proxy http://127.0.0.1:7890

  装完重启一次 DSH，然后「设置 → 远程访问」里改参数。
#>
[CmdletBinding()]
param(
  # GitHub 仓库（改名后写新名字即可，GitHub 会自动重定向旧地址）
  [string]$Repo = 'Mzy123l/dsh-remote-access-cidr',
  # 分支或 tag
  [string]$Ref = 'main',
  # 装到哪（默认用户级，不需要管理员）
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'dsh-plugins\dsh-remote-access-cidr'),
  # 走代理下载，例如 http://127.0.0.1:7890；留空 = 直连
  [string]$Proxy = '',
  # 目录已存在时覆盖
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

"==> 准备把 dsh-remote-access-cidr 取到: $InstallDir"
if ((Test-Path $InstallDir) -and -not $Force) {
  $existing = Join-Path $InstallDir 'package.json'
  if (Test-Path $existing) {
    "==> 该目录已存在（用 -Force 可覆盖）。如果你只是想重新安装，直接跳到下面的『下一步』。"
  }
}

$zip = Join-Path $env:TEMP "dsh-remote-access-cidr-$([guid]::NewGuid().ToString('N')).zip"
$staging = Join-Path $env:TEMP "dsh-remote-access-cidr-$([guid]::NewGuid().ToString('N'))"
$url = "https://codeload.github.com/$Repo/zip/refs/heads/$Ref"
# 分支不存在时（比如只打了 tag）退回 tag 形式
try {
  "==> 下载 $url"
  if ($Proxy) { Invoke-WebRequest -UseBasicParsing -Proxy $Proxy -Uri $url -OutFile $zip }
  else { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip }
} catch {
  $url = "https://codeload.github.com/$Repo/zip/refs/tags/$Ref"
  "==> 分支取不到，改试 tag: $url"
  if ($Proxy) { Invoke-WebRequest -UseBasicParsing -Proxy $Proxy -Uri $url -OutFile $zip }
  else { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip }
}

"==> 解包"
Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force
$root = Get-ChildItem $staging -Directory | Select-Object -First 1
if (-not $root) { throw "压缩包里没有目录，下载可能被劫持或仓库为空" }

# 认一下是不是这个插件：包名 + 清单里该有的东西
$manifest = Join-Path $root.FullName 'package.json'
if (-not (Test-Path $manifest)) { throw "取到的内容里没有 package.json，不是本插件仓库？" }
$pkg = Get-Content $manifest -Raw | ConvertFrom-Json
if ($pkg.name -ne 'dsh-remote-access-cidr') { throw "包名对不上（拿到的是 $($pkg.name)）" }
foreach ($need in 'index.js', 'client.js', 'cordis.patch.yml') {
  if (-not (Test-Path (Join-Path $root.FullName $need))) { throw "缺少 $need，仓库内容不完整" }
}

"==> 放到目标目录（版本 $($pkg.version)）"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Get-ChildItem $InstallDir -Force | Remove-Item -Recurse -Force
Copy-Item -Path (Join-Path $root.FullName '*') -Destination $InstallDir -Recurse -Force

Remove-Item $zip, $staging -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '下一步（安装动作交给 DSH 自己，别手工改 profile）:' -ForegroundColor Cyan
Write-Host "  1) 打开 DSH → 设置 → 插件 → 添加插件"
Write-Host "  2) 填这个目录的绝对路径："
Write-Host "     $InstallDir" -ForegroundColor Yellow
Write-Host "  3) 装完**重启一次 DSH**，然后到「设置 → 远程访问」里改参数"
Write-Host ''
Write-Host '也可以直接从 GitHub / npm 装（连这步都省了）:' -ForegroundColor Cyan
Write-Host "  · 插件页里填: github:$Repo"
Write-Host "  · 插件页里填: dsh-remote-access-cidr   （从 npm 装）"
Write-Host ''
