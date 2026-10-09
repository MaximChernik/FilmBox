; FilmBox: extra uninstall steps.
;
; electron-builder already removes $INSTDIR, shortcuts and the registry keys,
; and it wipes the app data only with an explicit --delete-app-data flag (or
; the unconditional deleteAppDataOnUninstall option). This macro adds the
; missing piece: a yes/no prompt so a regular uninstall can clean the last
; traces — %APPDATA%\FilmBox (settings, history, favorites, caches).
;
; The prompt lives in customUnInit (end of un.onInit), NOT in customUnInstall:
; one-click uninstallers call SetSilent silent after the "are you sure?" dialog
; (uninstaller.nsh), so a MessageBox inside the section would never be seen.

!macro customUnInit
  ${GetParameters} $R0

  ; explicit /S — fully scripted run, never block it with UI
  ${GetOptions} $R0 "/S" $R1
  ${IfNot} ${Errors}
    Goto fb_endDataPrompt
  ${EndIf}

  ; --delete-app-data — electron-builder's own block in the section wipes it
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    Goto fb_endDataPrompt
  ${EndIf}

  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Удалить также данные приложения?$\r$\n$\r$\n$APPDATA\FilmBox$\r$\n(настройки, история, избранное, кэш)$\r$\n$\r$\nНет — данные останутся на диске." \
      IDYES fb_wipeAppData
  Goto fb_endDataPrompt

fb_wipeAppData:
  ; app data is always per-user, even for a per-machine install
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endIf}
  RMDir /r "$APPDATA\FilmBox"
  ; legacy userData folder name (package.json "name")
  RMDir /r "$APPDATA\film-agg"
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endIf}

fb_endDataPrompt:
!macroend
