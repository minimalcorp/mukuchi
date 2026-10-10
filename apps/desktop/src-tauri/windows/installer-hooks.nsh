; Windows のインストーラー (NSIS) のフック。tauri.windows.conf.json の bundle.windows.nsis.installerHooks から
; tauri-cli 2.12.0 の installer.nsi (crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi) の先頭で !include される。
; 役割の分担は docs/architecture.md「同梱物・配布 (Windows)」のアンインストール:
;   アプリ内の「完全にアンインストール」は、実行中に消せないもの (データの下の EBWebView・ログ・インストール先の llama-server)
;   があるため何も消さず、`uninstall.exe /P /MUKUCHI_PURGE` を起動して終了する。削除はこのアンインストーラーが行う。
;
; テンプレートの動き (2.12.0 で確認):
;   - un.onInit が /P (PassiveMode) と /UPDATE (UpdateMode) を読む。/P では確認ページ (「アプリのデータを削除する」の
;     チェック) が出ないため $DeleteAppDataCheckboxState は 0 のまま
;   - Section Uninstall の先頭で NSIS_HOOK_PREUNINSTALL、本体・同梱物・ショートカット・HKCU の Run の値
;     ${PRODUCTNAME} を消し (/UPDATE でない時)、$DeleteAppDataCheckboxState = 1 かつ /UPDATE でなければ
;     $APPDATA\${BUNDLEID} と $LOCALAPPDATA\${BUNDLEID} を RmDir /r、最後に NSIS_HOOK_POSTUNINSTALL
;   - 更新 (tauri-plugin-updater) では新しい版のインストーラーが /P /UPDATE /R で起動され、古い版のアンインストーラーを
;     /UPDATE 付きで呼ぶ。この時はデータ・スタートアップの登録を消さない
; オプション名は GetOptions が前方一致で探すため、/P・/UPDATE・/NS・/R・/ARGS で始まらない名前にする。

Var MukuchiPurge

; インストールした言語を記録する。アンインストーラー (un.onInit の MUI_UNGETLANGUAGE) は HKCU\${MANUPRODUCTKEY} の
; "Installer Language" が無いと、/S (サイレント) 以外では言語を選ぶダイアログ (「Installer Language」) を出して止まる。
; テンプレートはこの値を言語の選択画面 (displayLanguageSelector) を出した時にしか書かないため、2 言語のままだと
; アプリからの `uninstall.exe /P /MUKUCHI_PURGE` も 設定 > アプリ からの削除もダイアログで止まる (実測)。
; アンインストール (データ削除あり) ではテンプレートがこの値を消す
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "${MANUPRODUCTKEY}" "Installer Language" $LANGUAGE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $MukuchiPurge 0
  ClearErrors
  ${GetOptions} $CMDLINE "/MUKUCHI_PURGE" $R0
  ${IfNot} ${Errors}
  ${AndIf} $UpdateMode <> 1
    StrCpy $MukuchiPurge 1
    ; テンプレートにデータ (%LOCALAPPDATA%\<バンドルID>: 設定・モデル・ログ・EBWebView) を消させる
    StrCpy $DeleteAppDataCheckboxState 1
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    ; タスク マネージャー・設定 > スタートアップ でオフにした記録 (アプリが Run と同じ名前で読む)。テンプレートは消さない
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${PRODUCTNAME}"
  ${EndIf}
  ; アプリの終了直後は WebView2 のプロセスが EBWebView を掴んでいることがある。消し残ったら待って消し直す (最大 約 10 秒)
  ${If} $MukuchiPurge = 1
    SetShellVarContext current
    StrCpy $R1 0
    ${DoWhile} ${FileExists} "$LOCALAPPDATA\${BUNDLEID}\*.*"
      ${If} $R1 >= 20
        DetailPrint "not removed: $LOCALAPPDATA\${BUNDLEID}"
        ${Break}
      ${EndIf}
      Sleep 500
      RMDir /r "$LOCALAPPDATA\${BUNDLEID}"
      IntOp $R1 $R1 + 1
    ${Loop}
  ${EndIf}
!macroend
