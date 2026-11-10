; This hook replaces electron-builder's image-name/taskkill fallback. It runs
; before uninstallOldVersion and installApplicationFiles in installSection.nsh.
Var cruxLifecycleAttempt
Var cruxLifecycleArguments
!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    ; The built-in installer also uninstalls registered locations. Refuse a
    ; different target rather than letting it bypass this exact-path gate.
    ReadRegStr $R6 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R6 != ""
      GetFullPathName $R6 "$R6"
      GetFullPathName $R7 "$INSTDIR"
      ${If} $R6 != $R7
        ${IfNot} ${Silent}
          MessageBox MB_OK|MB_ICONEXCLAMATION "更新必须选择原 Crux 安装目录。未更改任何程序文件。"
        ${EndIf}
        SetErrorLevel 3
        Quit
      ${EndIf}
      ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        ; A renamed/partial historical installation cannot silently fall
        ; through to the old uninstaller's unscoped process-name fallback.
        ${IfNot} ${Silent}
          MessageBox MB_OK|MB_ICONEXCLAMATION "原安装的可执行文件身份无法核实，更新已取消。请先修复原安装。"
        ${EndIf}
        SetErrorLevel 3
        Quit
      ${EndIf}
    ${EndIf}
    ${If} $installMode == "all"
      ReadRegStr $R6 HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $R6 != ""
        GetFullPathName $R6 "$R6"
        GetFullPathName $R7 "$INSTDIR"
        ${If} $R6 != $R7
          SetErrorLevel 3
          Quit
        ${EndIf}
      ${EndIf}
    ${EndIf}
  !endif
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    Push $OUTDIR
    InitPluginsDir
    !ifdef BUILD_UNINSTALLER
      ; The installed controller is intact until this check returns.
      StrCpy $R8 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      ${StdUtils.GetParameter} $cruxLifecycleAttempt "crux-lifecycle-reconcile" ""
      StrCpy $cruxLifecycleArguments ""
      ${If} $cruxLifecycleAttempt != ""
        StrCpy $cruxLifecycleArguments "--trellis-maintenance-reconcile=$cruxLifecycleAttempt"
      ${EndIf}
    !else
      ; Use the NEW controller for the first upgrade from a pre-protocol app.
      ; Never depend on code that the following uninstall/overwrite removes.
      SetOutPath "$PLUGINSDIR\crux-maintenance"
      !ifdef APP_64
        File /oname=$PLUGINSDIR\crux-maintenance.7z "${APP_64}"
        Nsis7z::Extract "$PLUGINSDIR\crux-maintenance.7z"
      !else
        !error "Crux lifecycle maintenance requires the embedded Windows x64 package"
      !endif
      StrCpy $R8 "$PLUGINSDIR\crux-maintenance\${APP_EXECUTABLE_FILENAME}"
      Delete "$PLUGINSDIR\crux-lifecycle-receipt.txt"
      StrCpy $cruxLifecycleArguments '"--trellis-maintenance-receipt=$PLUGINSDIR\crux-lifecycle-receipt.txt"'
    !endif
    ${If} ${Silent}
      ExecWait '"$R8" --trellis-role=maintenance "--trellis-target-install=$INSTDIR" $cruxLifecycleArguments --trellis-maintenance-silent' $R9
    ${Else}
      ExecWait '"$R8" --trellis-role=maintenance "--trellis-target-install=$INSTDIR" $cruxLifecycleArguments' $R9
    ${EndIf}
    Pop $R8
    SetOutPath $R8
    ${If} $R9 != 0
      SetErrorLevel $R9
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "Crux 未完成退出，安装已取消。原程序文件尚未替换。"
      ${EndIf}
      Quit
    ${EndIf}
    !ifndef BUILD_UNINSTALLER
      ; Only this installer's exact released attempt may be reconciled by the
      ; old installed controller. Its own build is not the successor target.
      ClearErrors
      FileOpen $R6 "$PLUGINSDIR\crux-lifecycle-receipt.txt" r
      ${If} ${Errors}
        SetErrorLevel 3
        Quit
      ${EndIf}
      FileRead $R6 $R7
      FileClose $R6
      StrCpy $cruxLifecycleAttempt $R7 101
      StrLen $R6 $cruxLifecycleAttempt
      ${If} $R6 != 101
        SetErrorLevel 3
        Quit
      ${EndIf}
      ; Historical electron-builder uninstallers run a process-image-name kill
      ; before deleting files. After exact native handoff, invoke that original
      ; uninstaller under APP_EXECUTABLE_FILENAME: its documented self-image
      ; guard skips that broad fallback. _? keeps the actual removal target
      ; pinned to INSTDIR. Its registry removal makes the later stock
      ; uninstallOldVersion call a no-op.
      ReadRegStr $R6 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
      ${If} $R6 != ""
        !insertmacro GetInQuotes $R7 "$R6"
        Push $R7
        Call GetFileParent
        Pop $R6
        GetFullPathName $R6 "$R6"
        GetFullPathName $R8 "$INSTDIR"
        ${If} $R6 != $R8
          SetErrorLevel 3
          Quit
        ${EndIf}
        CreateDirectory "$PLUGINSDIR\crux-original-uninstaller"
        CopyFiles /SILENT "$R7" "$PLUGINSDIR\crux-original-uninstaller\${APP_EXECUTABLE_FILENAME}"
        ${If} $installMode == "CurrentUser"
          StrCpy $R6 "/currentuser"
        ${Else}
          StrCpy $R6 "/allusers"
        ${EndIf}
        ExecWait '"$PLUGINSDIR\crux-original-uninstaller\${APP_EXECUTABLE_FILENAME}" /S /KEEP_APP_DATA $R6 --crux-lifecycle-reconcile=$cruxLifecycleAttempt --updated --keep-shortcuts _?=$INSTDIR' $R9
        ${If} $R9 != 0
          SetErrorLevel $R9
          Quit
        ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
!macroend
