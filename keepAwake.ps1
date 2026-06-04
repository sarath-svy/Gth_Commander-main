# ==========================================
# KEEP-AWAKE GUARD
# ==========================================
# Spawned by server.js when the swarm starts; killed when it stops. While this
# process is alive it tells Windows not to sleep or turn off the display (which
# also stops the idle screen-lock). The flag is bound to this process — when the
# process exits (stopped, or server crashes), Windows automatically restores the
# user's normal sleep/lock behaviour. No global power settings are changed.
#
# -ParentPid lets us self-terminate if the server dies unexpectedly, so the PC
# is never left awake forever.
# ==========================================
param([int]$ParentPid = 0)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Power {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@

$ES_CONTINUOUS       = [uint32]"0x80000000"
$ES_SYSTEM_REQUIRED  = [uint32]"0x00000001"
$ES_DISPLAY_REQUIRED = [uint32]"0x00000002"
$flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_DISPLAY_REQUIRED

while ($true) {
  # Re-assert every loop (harmless, and extra-robust if anything resets it).
  [Power]::SetThreadExecutionState($flags) | Out-Null
  Start-Sleep -Seconds 5
  if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
}
# Falling out of the loop ends the process, which clears the execution state.
