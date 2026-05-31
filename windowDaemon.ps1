# ==========================================
# PERSISTENT WINDOW DAEMON
# ==========================================
# Started ONCE by the server and kept alive. The server writes commands to
# stdin; the C# helper is compiled only once, so each command runs instantly
# (no per-call PowerShell startup or Add-Type recompile).
#
# Commands (one per line):
#   FOCUS <exe> <id>     -> bring "Drone <id>" to front, minimize other drones
#   RESTORE <exe>        -> un-minimize all drone windows
#   QUIT                 -> exit
# ==========================================

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinD {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@

$SW_MIN = 6; $SW_RESTORE = 9
$TOPMOST = New-Object IntPtr(-1)
$NOTOPMOST = New-Object IntPtr(-2)
$SWP = 0x0001 -bor 0x0002 -bor 0x0040

function Get-DroneWindows([string]$exe) {
  $procName = $exe -replace '\.exe$',''
  return Get-Process -Name $procName -ErrorAction SilentlyContinue |
         Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'Drone\s+\d+' }
}

Write-Output "DAEMON_READY"

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { Start-Sleep -Milliseconds 50; continue }
  $line = $line.Trim()
  if ($line -eq "") { continue }
  $parts = $line.Split(" ")
  $cmd = $parts[0].ToUpper()

  if ($cmd -eq "QUIT") { break }

  elseif ($cmd -eq "FOCUS") {
    $exe = $parts[1]; $focus = [int]$parts[2]
    foreach ($w in (Get-DroneWindows $exe)) {
      if ($w.MainWindowTitle -match 'Drone\s+(\d+)') {
        $id = [int]$Matches[1]; $h = $w.MainWindowHandle
        if ($id -eq $focus) {
          [WinD]::ShowWindowAsync($h, $SW_RESTORE) | Out-Null
          [WinD]::SetWindowPos($h, $TOPMOST, 0,0,0,0, $SWP) | Out-Null
          [WinD]::SetWindowPos($h, $NOTOPMOST, 0,0,0,0, $SWP) | Out-Null
          [WinD]::SetForegroundWindow($h) | Out-Null
        } else {
          [WinD]::ShowWindowAsync($h, $SW_MIN) | Out-Null
        }
      }
    }
    Write-Output "OK FOCUS $focus"
  }

  elseif ($cmd -eq "RESTORE") {
    $exe = $parts[1]
    foreach ($w in (Get-DroneWindows $exe)) {
      [WinD]::ShowWindowAsync($w.MainWindowHandle, $SW_RESTORE) | Out-Null
    }
    Write-Output "OK RESTORE"
  }
}
