; Дополнение к установщику Local VOT (electron-builder, NSIS).
; Папку настроек %APPDATA%\Local VOT деинсталлятор удаляет сам (deleteAppDataOnUninstall).
!macro customUnInstall
  ; временные файлы и кэш переводов — обычно их убирает сама программа при выходе
  RMDir /r "$TEMP\local-vot"
  ; копия установщика, которую electron-builder сохраняет для будущих обновлений (~120 МБ)
  RMDir /r "$LOCALAPPDATA\local-vot-updater"
!macroend
