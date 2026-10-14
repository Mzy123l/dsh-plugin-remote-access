# watch-notify-poll.ps1 —— 旁观手机的长轮询：连接每次建立/断开都记一行
#
# 用途：判断「手机到底有没有在长轮询 / 有没有在状态一变时立刻把连接收掉」。
# 正常情况一次长轮询挂 20 秒；一旦有条待答选择出现，宿主会立刻回答，
# 于是那一次连接的寿命只有一两秒 —— 那就是「手机第一时间就知道了」的证据。
param(
  [string]$LogFile = "$env:TEMP\dsh-notify-poll.log",
  [string]$Peer = '100.64.0.4',
  [int]$Minutes = 8
)
$deadline = (Get-Date).AddMinutes($Minutes)
$last = ''
"# start $(Get-Date -Format 'HH:mm:ss.fff')" | Set-Content $LogFile
while ((Get-Date) -lt $deadline) {
  $ports = @(Get-NetTCPConnection -LocalPort 19388 -State Established -ErrorAction SilentlyContinue |
    Where-Object { $_.RemoteAddress -eq $Peer } |
    Select-Object -ExpandProperty RemotePort | Sort-Object)
  $now = ($ports -join ',')
  if ($now -ne $last) {
    $seen = if ($now) { $now } else { '(无)' }
    "$(Get-Date -Format 'HH:mm:ss.fff')  $seen" | Add-Content $LogFile
    $last = $now
  }
  Start-Sleep -Milliseconds 300
}
"# end   $(Get-Date -Format 'HH:mm:ss.fff')" | Add-Content $LogFile
