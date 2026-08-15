# Close every process of this installation before an install or an uninstall
# touches the installation directory.
#
# electron-builder's own check does not fit this application. It gives up after
# two force-kill rounds in about six seconds, and it terminates single
# processes rather than process trees, while this application runs more than
# one process under its own image name: the desktop shell spawns the harness
# runtime from its own executable through ELECTRON_RUN_AS_NODE, and the
# supervisor restarts a runtime that has served for a minute with no delay.
# Terminating either process alone leaves the other to be found on the next
# scan, which is what raises "cannot be closed" while installed files stay
# locked and the install stalls.
#
# Two properties matter more than the budget. Termination is unconditional:
# a check that first probes and acts only on a positive result skips the close
# entirely whenever the probe command itself fails, and terminating nothing
# costs one command that reports no match. And a pass matches processes both
# by image name and by an executable under the installation directory, because
# the pty helpers and native hosts the runtime leaves behind carry neither the
# application's name nor, once their parent is gone, a tree that `/T` reaches
# from it.
#
# `taskkill /T` still terminates each image-name match together with its
# children, so a live shell goes down with the runtime and the shells it
# started, and nothing survives to restart anything.

# Passes before the installer reports that it cannot close the application.
!define DSH_CLOSE_ATTEMPTS 20

# Pause between a kill and the check that follows it, in milliseconds.
!define DSH_CLOSE_POLL_MS 500

# Distinct label suffix per insertion: NSIS compiles the installer and the
# uninstaller as one script, and each inserts this macro.
!macro dshNextCloseId
  !ifndef DSH_CLOSE_ID
    !define DSH_CLOSE_ID 0
  !else
    !define /redef /math DSH_CLOSE_ID ${DSH_CLOSE_ID} + 1
  !endif
!macroend

# Set $R3 to 0 when PowerShell runs here. The check the default macro uses for
# this is unavailable: it initializes its variable only on the branch this file
# replaces, so the path-matching passes below carry their own probe.
!macro dshProbePowerShell
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -Command "exit 0"`
  Pop $R3
!macroend

# Report whether any process belongs to this installation, by image name or by
# an executable under the installation directory. Sets the given register to 0
# when one is running.
!macro dshFindAppProcess _RESULT
  nsExec::Exec `"$CmdPath" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop ${_RESULT}
  ${if} ${_RESULT} != 0
  ${andIf} $R3 == 0
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -Command "if ((Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }"`
    Pop ${_RESULT}
  ${endIf}
!macroend

# Terminate this installation's processes by image name and by path, without
# first asking whether any are running.
!macro dshKillAppProcesses
  nsExec::Exec `"$CmdPath" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $R2
  ${if} $R3 == 0
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -Command "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    Pop $R2
  ${endIf}
!macroend

!macro customCheckAppRunning
  !insertmacro dshNextCloseId
  !insertmacro dshProbePowerShell

  !insertmacro dshFindAppProcess $R0
  ${if} $R0 == 0
    ${ifNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK dshCloseApp_${DSH_CLOSE_ID}
      Quit
    ${endIf}
  ${endIf}

  dshCloseApp_${DSH_CLOSE_ID}:
  ${if} $R0 == 0
    DetailPrint "$(appClosing)"
  ${endIf}
  StrCpy $R1 0
  ${Do}
    IntOp $R1 $R1 + 1
    !insertmacro dshKillAppProcesses
    Sleep ${DSH_CLOSE_POLL_MS}
    !insertmacro dshFindAppProcess $R0
    ${if} $R0 != 0
      ${ExitDo}
    ${endIf}
    ${if} $R1 >= ${DSH_CLOSE_ATTEMPTS}
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDOK
      Quit
    ${endIf}
  ${Loop}
!macroend
