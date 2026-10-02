<#
  install.ps1 —— 从 GitHub 取回 dsh-remote-access-cidr，放到固定目录，并尽量把安装这一步也替你走完。

  两段动作，互相独立：

    1) 取代码（一定做）：下载 zip → 校验（包名 + 必需文件）→ 落盘到 $InstallDir，
       旧版本会先备份成 $InstallDir.bak-<时间>，出错可以退回去。
    2) 装进 DSH（-Install 时做）：优先调用 dsh CLI（`dsh plugin --profile <名> add <目录>`）。
       DSH 正在运行时 profile 有写锁，这时不会硬闯，只把该做的事说清楚。

  为什么默认不直接改 profile：插件安装要写 profile 的 package.json / cordis.patch.yml 并跑包管理器，
  那是 DSH 自己的活；手工改容易把 profile 弄坏（本插件 README 里也这么写）。所以默认只把代码备好，
  由你（或 -Install）交给 DSH。

  用法（任选一种）：

    # A. 直接跑（默认取 main，落到 %LOCALAPPDATA%\dsh-plugins\dsh-remote-access-cidr）
    irm https://raw.githubusercontent.com/Mzy123l/dsh-remote-access-cidr/main/install.ps1 | iex

    # B. 带参数：代理 / 换目录 / 换分支 / 顺便装进 DSH
    $s = irm https://raw.githubusercontent.com/Mzy123l/dsh-remote-access-cidr/main/install.ps1
    & ([scriptblock]::Create($s)) -Proxy http://127.0.0.1:7890 -Force -Install

    # C. 装还没合并进 main 的分支（例如 PR 上的新功能）
    & ([scriptblock]::Create($s)) -Repo Sonder-Traveller/dsh-remote-access-cidr -Ref fix/aborted-downstream-crash -Install

  装完重启一次 DSH，然后「设置 → 远程访问」里改参数；手机网址在 <DSH_HOME>\remote-access-url.txt。
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
  # 目录已存在时覆盖（会先备份旧版本）
  [switch]$Force,
  # 取完代码后，顺手让 dsh CLI 把它装进这个 profile（DSH 正在运行时自动跳过）
  [switch]$Install,
  # -Install 用的 profile 名
  [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Warn2([string]$text) { Write-Host "!!  $text" -ForegroundColor Yellow }

function Invoke-Download([string]$Uri, [string]$OutFile) {
  $params = @{ UseBasicParsing = $true; Uri = $Uri; OutFile = $OutFile }
  if ($Proxy) { $params['Proxy'] = $Proxy }
  Invoke-WebRequest @params
}

# ---------------------------------------------------------------- 1) 取代码

Write-Step "准备把 dsh-remote-access-cidr 取到: $InstallDir"
$hasOld = Test-Path (Join-Path $InstallDir 'package.json')
if ($hasOld -and -not $Force) {
  Write-Warn2 '该目录里已经有一份（加 -Force 才会覆盖）。如果你只是想重新装一遍，跳到下面的『下一步』。'
}

$zip = Join-Path $env:TEMP "dsh-remote-access-cidr-$([guid]::NewGuid().ToString('N')).zip"
$staging = Join-Path $env:TEMP "dsh-remote-access-cidr-$([guid]::NewGuid().ToString('N'))"

$url = "https://codeload.github.com/$Repo/zip/refs/heads/$Ref"
try {
  Write-Step "下载 $url"
  Invoke-Download $url $zip
} catch {
  $url = "https://codeload.github.com/$Repo/zip/refs/tags/$Ref"
  Write-Step "分支取不到，改试 tag: $url"
  try {
    Invoke-Download $url $zip
  } catch {
    Write-Warn2 "下载失败：$($_.Exception.Message)"
    Write-Warn2 '常见原因：网络/需要代理（-Proxy http://127.0.0.1:7890）、仓库或分支名写错、GitHub 暂时不可达。'
    throw '下载失败，未改动本机任何东西。'
  }
}

Write-Step '解包并校验'
Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force
$root = Get-ChildItem $staging -Directory | Select-Object -First 1
if (-not $root) { throw '压缩包里没有目录，下载可能被劫持或仓库为空' }

$manifest = Join-Path $root.FullName 'package.json'
if (-not (Test-Path $manifest)) { throw '取到的内容里没有 package.json，不是本插件仓库？' }
$pkg = Get-Content $manifest -Raw | ConvertFrom-Json
if ($pkg.name -ne 'dsh-remote-access-cidr') { throw "包名对不上（拿到的是 $($pkg.name)）" }
foreach ($need in 'index.js', 'client.js', 'cordis.patch.yml') {
  if (-not (Test-Path (Join-Path $root.FullName $need))) { throw "缺少 $need，仓库内容不完整" }
}
$skipped = @()
foreach ($optional in 'install.ps1', 'README.md') {
  if (-not (Test-Path (Join-Path $root.FullName $optional))) { $skipped += $optional }
}
Write-Step "校验通过：$($pkg.name) $($pkg.version)（来自 $Repo@$Ref）"
if ($skipped.Count -gt 0) { Write-Warn2 "仓库里没有：$($skipped -join ', ')" }

# 覆盖前先备份：装坏了能整目录退回去
$backup = $null
if (Test-Path $InstallDir) {
  $backup = "$InstallDir.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Write-Step "备份旧版本 → $backup"
  Move-Item -LiteralPath $InstallDir -Destination $backup -Force
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $root.FullName '*') -Destination $InstallDir -Recurse -Force
Remove-Item $zip, $staging -Recurse -Force -ErrorAction SilentlyContinue
Write-Step "已放到 $InstallDir"

# ---------------------------------------------------------------- 2) 装进 DSH（可选）

$installed = $false
if ($Install) {
  $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'DeepSeek Harness' })
  $dsh = Get-Command dsh -ErrorAction SilentlyContinue
  if ($running.Count -gt 0) {
    Write-Warn2 "DSH 正在运行（$($running.Count) 个进程），profile 有写锁 —— -Install 这步先跳过。"
    Write-Warn2 '关掉 DSH 后再跑一次，或用设置页的「添加插件」填下面那个目录。'
  } elseif (-not $dsh) {
    Write-Warn2 'PATH 里没有 dsh 命令 —— -Install 这步先跳过，用设置页的「添加插件」。'
  } else {
    Write-Step "调用 dsh plugin --profile $Profile add `"$InstallDir`""
    try {
      & $dsh.Source plugin --profile $Profile add $InstallDir
      $installed = $true
      Write-Step '已交给 DSH 安装（它自己写 profile）'
    } catch {
      Write-Warn2 "dsh CLI 安装失败：$($_.Exception.Message)"
      Write-Warn2 '改用设置页的「添加插件」填那个目录即可。'
    }
  }
}

# ---------------------------------------------------------------- 下一步

Write-Host ''
Write-Host '下一步' -ForegroundColor Cyan
if ($installed) {
  Write-Host '  1) 重启一次 DSH（宿主半区的配置字段要重启才加载）'
} else {
  Write-Host '  1) 打开 DSH → 设置 → 插件 → 添加插件，填这个目录的绝对路径：'
  Write-Host "     $InstallDir" -ForegroundColor Yellow
  Write-Host '  2) 装完重启一次 DSH'
}
Write-Host '  3) 「设置 → 远程访问」里设访问密码 / 远程UI布局 / UI 设置'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
Write-Host "  4) 手机网址看这里的『手机访问』那一行：$(Join-Path $dshHome 'remote-access-url.txt')" -ForegroundColor Yellow
Write-Host ''
Write-Host '也可以完全不用这个脚本（插件页直接填）:' -ForegroundColor Cyan
Write-Host "  · github:$Repo                （可直接带 #分支 或 #commit）"
Write-Host "  · dsh-remote-access-cidr      （从 npm 装，发布后可用）"
if ($backup) { Write-Host ''; Write-Host "旧的版本备份在：$backup（确认没问题后可以删掉）" -ForegroundColor DarkGray }
Write-Host ''

# 已经用 github: 装过同一个插件时提醒一句：profile 里那份是钉死的 commit，不会自动变成这个目录
$profileFile = Join-Path $dshHome "profiles\$Profile\package.json"
if (Test-Path $profileFile) {
  $spec = (Get-Content $profileFile -Raw | ConvertFrom-Json).dependencies.'dsh-remote-access-cidr'
  if ($spec -and "$spec" -notmatch '^(link:|file:|\.|/|[A-Za-z]:)') {
    Write-Warn2 "你的 profile 里已经用的是「$spec」——它钉死在那个来源，不会自动换成这个目录。"
    Write-Warn2 "想换成这份代码：先在设置 → 插件里把它移除，再用上面的目录重新添加。"
  }
}
