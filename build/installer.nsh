; Дополнение к установщику Local VOT (electron-builder, NSIS).
; Папку настроек %APPDATA%\Local VOT деинсталлятор удаляет сам (deleteAppDataOnUninstall) — и только при
; настоящем удалении: при установке новой версии поверх старой electron-builder запускает старый
; деинсталлятор с флагом «обновление», и настройки остаются.
!macro customUnInstall
  ; при обновлении ничего не убираем — иначе новая версия потеряла бы настройки уведомлений Windows
  ${ifNot} ${isUpdated}
    ; временные файлы и кэш переводов — обычно их убирает сама программа при выходе
    RMDir /r "$TEMP\local-vot"
    ; копия установщика, которую electron-builder сохраняет для будущих обновлений (~120 МБ)
    RMDir /r "$LOCALAPPDATA\local-vot-updater"
    ; уведомления Windows: имя и значок программы, которые она регистрирует, и настройки уведомлений,
    ; которые Windows заводит для неё сама
    DeleteRegKey HKCU "Software\Classes\AppUserModelId\io.github.solidsnake1765.localvot"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\io.github.solidsnake1765.localvot"
  ${endIf}
!macroend
