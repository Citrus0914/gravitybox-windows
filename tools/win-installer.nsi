; GravityBox Windows Installer (NSIS)
; Built via tools/package-win.mjs with defines:
;   APP_VERSION, STAGE_DIR, OUT_FILE, ICON_FILE, LICENSE_FILE

Unicode True
!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "1.1.1"
!endif
!ifndef STAGE_DIR
  !error "STAGE_DIR must be defined"
!endif
!ifndef OUT_FILE
  !error "OUT_FILE must be defined"
!endif
!ifndef ICON_FILE
  !error "ICON_FILE must be defined"
!endif
!ifndef LICENSE_FILE
  !error "LICENSE_FILE must be defined"
!endif

Name "GravityBox ${APP_VERSION}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\GravityBox"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GravityBox" "InstallLocation"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show
SetCompressor /SOLID lzma

!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\GravityBox.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch GravityBox"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${LICENSE_FILE}"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ; Warn non-blocking if Microsoft Edge WebView2 Runtime is missing (only in interactive UI)
  IfSilent +11
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $0 == ""
    ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $0 == ""
    MessageBox MB_ICONINFORMATION|MB_OK "Microsoft Edge WebView2 Runtime was not detected. GravityBox requires WebView2 Runtime (built into Windows 10/11). You can continue installation and install WebView2 Runtime if needed."
  ${EndIf}
FunctionEnd

Section "GravityBox" SecMain
  SectionIn RO

  ; Stop any running GravityBox process before replacing files
  nsExec::Exec 'taskkill.exe /IM GravityBox.exe /F'
  Sleep 400

  SetOutPath "$INSTDIR"
  File /r "${STAGE_DIR}\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Start Menu & Desktop shortcuts
  CreateDirectory "$SMPROGRAMS\GravityBox"
  CreateShortcut "$SMPROGRAMS\GravityBox\GravityBox.lnk" "$INSTDIR\GravityBox.exe" "" "$INSTDIR\GravityBox.exe" 0
  CreateShortcut "$SMPROGRAMS\GravityBox\Uninstall GravityBox.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\Uninstall.exe" 0
  CreateShortcut "$DESKTOP\GravityBox.lnk" "$INSTDIR\GravityBox.exe" "" "$INSTDIR\GravityBox.exe" 0

  ; Per-user Uninstall registry metadata (HKCU)
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GravityBox" "DisplayName" "GravityBox"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GravityBox" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GravityBox" "Publisher" "Enzoo404"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GravityBox" "DisplayIcon" "$INSTDIR\GravityBox.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GravityBox" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GravityBox" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GravityBox" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GravityBox" "NoRepair" 1
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill.exe /IM GravityBox.exe /F'
  Sleep 400

  ; Remove shortcuts
  Delete "$DESKTOP\GravityBox.lnk"
  Delete "$SMPROGRAMS\GravityBox\GravityBox.lnk"
  Delete "$SMPROGRAMS\GravityBox\Uninstall GravityBox.lnk"
  RMDir "$SMPROGRAMS\GravityBox"

  ; Remove application binaries and core bundle (preserve user state in %LocalAppData%\GravityBox)
  RMDir /r "$INSTDIR\core"
  RMDir /r "$INSTDIR\runtime"
  Delete "$INSTDIR\GravityBox.exe"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\THIRD_PARTY_NOTICES.md"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  ; Clean registry entries including auto-start entry
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GravityBox"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "GravityBox"
SectionEnd
