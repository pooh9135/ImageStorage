!ifndef BUILD_UNINSTALLER
!include "nsDialogs.nsh"

Var ConnectorChromeCheck
Var ConnectorEdgeCheck
Var ConnectorZenCheck
Var ConnectorChromeSelected
Var ConnectorEdgeSelected
Var ConnectorZenSelected
Var ConnectorChoicesInitialized
Var ConnectorChromeExe
Var ConnectorEdgeExe
Var ConnectorZenExe
Var ConnectorBrowser
Var ConnectorBrowserExe
Var ConnectorAddress
Var ConnectorPath
Var ConnectorFolder
Var ConnectorLoadStep
Var ConnectorTip
Var ConnectorAddressText
Var ConnectorPathText

!macro ConnectorText output english japanese
  ${If} $LANGUAGE == 1041
    StrCpy ${output} "${japanese}"
  ${Else}
    StrCpy ${output} "${english}"
  ${EndIf}
!macroend

; Finds a browser executable through the App Paths registration (per-machine, then per-user).
!macro FindBrowserExe output exeName
  ReadRegStr ${output} HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\${exeName}" ""
  ${If} ${output} == ""
    ReadRegStr ${output} HKCU "SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\${exeName}" ""
  ${EndIf}
  ${If} ${output} != ""
    ${IfNot} ${FileExists} "${output}"
      StrCpy ${output} ""
    ${EndIf}
  ${EndIf}
!macroend

!macro customFinishPage
  Page custom ChooseBrowserConnectors SaveBrowserConnectorChoices
  Page custom ShowChromeConnectorGuide
  Page custom ShowEdgeConnectorGuide
  Page custom ShowZenConnectorGuide

  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${Else}
        StrCpy $1 ""
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customHeader
Function ChooseBrowserConnectors
  ${If} $ConnectorChoicesInitialized != "1"
    StrCpy $ConnectorChoicesInitialized "1"
    !insertmacro FindBrowserExe $ConnectorChromeExe "chrome.exe"
    !insertmacro FindBrowserExe $ConnectorEdgeExe "msedge.exe"
    !insertmacro FindBrowserExe $ConnectorZenExe "zen.exe"
    ${If} $ConnectorZenExe == ""
      ${If} ${FileExists} "$PROGRAMFILES64\Zen Browser\zen.exe"
        StrCpy $ConnectorZenExe "$PROGRAMFILES64\Zen Browser\zen.exe"
      ${EndIf}
    ${EndIf}
    ; Recommend the extension: browsers found on this PC start checked (Edge stays opt-in).
    StrCpy $ConnectorChromeSelected ${BST_UNCHECKED}
    StrCpy $ConnectorEdgeSelected ${BST_UNCHECKED}
    StrCpy $ConnectorZenSelected ${BST_UNCHECKED}
    ${If} $ConnectorChromeExe != ""
      StrCpy $ConnectorChromeSelected ${BST_CHECKED}
    ${EndIf}
    ${If} $ConnectorZenExe != ""
      StrCpy $ConnectorZenSelected ${BST_CHECKED}
    ${EndIf}
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  !insertmacro ConnectorText $1 "Browser extension (recommended)" "ブラウザー拡張機能（おすすめ）"
  !insertmacro ConnectorText $2 "Send images to ImageStorage straight from your browser." "ブラウザーから ImageStorage へ画像を直接送れるようにします。"
  !insertmacro MUI_HEADER_TEXT "$1" "$2"

  !insertmacro ConnectorText $1 "With the ImageStorage extension, right-click any image on a web page and choose Save to ImageStorage to add it to a list. We recommend setting it up now. Select your browsers and the next pages walk you through it step by step (about 1 minute)." "拡張機能を入れると、Webページの画像を右クリック →「ImageStorageに保存…」で、そのままリストに追加できます。今のうちに導入しておくのがおすすめです。使うブラウザーを選ぶと、次の画面で導入手順を1つずつ案内します（約1分）。"
  ${NSD_CreateLabel} 0 0 100% 40u "$1"
  Pop $0

  !insertmacro ConnectorText $2 " (installed)" "（インストール済み）"
  StrCpy $1 "Google Chrome"
  ${If} $ConnectorChromeExe != ""
    StrCpy $1 "$1$2"
  ${EndIf}
  ${NSD_CreateCheckBox} 8u 44u 92% 12u "$1"
  Pop $ConnectorChromeCheck
  ${If} $ConnectorChromeSelected == ${BST_CHECKED}
    ${NSD_Check} $ConnectorChromeCheck
  ${EndIf}

  StrCpy $1 "Microsoft Edge"
  ${If} $ConnectorEdgeExe != ""
    StrCpy $1 "$1$2"
  ${EndIf}
  ${NSD_CreateCheckBox} 8u 58u 92% 12u "$1"
  Pop $ConnectorEdgeCheck
  ${If} $ConnectorEdgeSelected == ${BST_CHECKED}
    ${NSD_Check} $ConnectorEdgeCheck
  ${EndIf}

  StrCpy $1 "Zen Browser / Firefox"
  ${If} $ConnectorZenExe != ""
    StrCpy $1 "$1$2"
  ${EndIf}
  ${NSD_CreateCheckBox} 8u 72u 92% 12u "$1"
  Pop $ConnectorZenCheck
  ${If} $ConnectorZenSelected == ${BST_CHECKED}
    ${NSD_Check} $ConnectorZenCheck
  ${EndIf}

  !insertmacro ConnectorText $1 "To skip for now, clear all boxes and click Next. You can set it up later with 使い方.txt in the browser-connector folder." "あとで導入する場合は、チェックを外して「次へ」を押してください。インストール先の browser-connector フォルダーにある「使い方.txt」からいつでも導入できます。"
  ${NSD_CreateLabel} 0 92u 100% 22u "$1"
  Pop $0
  !insertmacro ConnectorText $1 "Open 使い方.txt" "使い方.txt を開く"
  ${NSD_CreateButton} 0 117u 100u 15u "$1"
  Pop $0
  ${NSD_OnClick} $0 OpenConnectorReadme
  nsDialogs::Show
FunctionEnd

Function SaveBrowserConnectorChoices
  ${NSD_GetState} $ConnectorChromeCheck $ConnectorChromeSelected
  ${NSD_GetState} $ConnectorEdgeCheck $ConnectorEdgeSelected
  ${NSD_GetState} $ConnectorZenCheck $ConnectorZenSelected
FunctionEnd

Function ShowChromeConnectorGuide
  ${If} $ConnectorChromeSelected != ${BST_CHECKED}
    Abort
  ${EndIf}
  StrCpy $ConnectorBrowser "Chrome"
  StrCpy $ConnectorBrowserExe $ConnectorChromeExe
  StrCpy $ConnectorAddress "chrome://extensions/"
  StrCpy $ConnectorPath "$INSTDIR\browser-connector\chromium"
  StrCpy $ConnectorFolder "$INSTDIR\browser-connector\chromium"
  !insertmacro ConnectorText $ConnectorLoadStep "3. On that page, turn on Developer mode (top right), click Load unpacked, and select this folder." "3. 開いたページの右上「デベロッパーモード」をオンにし、「パッケージ化されていない拡張機能を読み込む」でこのフォルダーを選びます。"
  !insertmacro ConnectorText $ConnectorTip "Done! Reload the page with the image, then right-click the image and choose Save to ImageStorage." "完了です。画像のあるページを再読み込みし、画像を右クリック →「ImageStorageに保存…」で送れます。"
  Call ShowBrowserConnectorGuide
FunctionEnd

Function ShowEdgeConnectorGuide
  ${If} $ConnectorEdgeSelected != ${BST_CHECKED}
    Abort
  ${EndIf}
  StrCpy $ConnectorBrowser "Edge"
  StrCpy $ConnectorBrowserExe $ConnectorEdgeExe
  StrCpy $ConnectorAddress "edge://extensions/"
  StrCpy $ConnectorPath "$INSTDIR\browser-connector\chromium"
  StrCpy $ConnectorFolder "$INSTDIR\browser-connector\chromium"
  !insertmacro ConnectorText $ConnectorLoadStep "3. On that page, turn on Developer mode (left menu), click Load unpacked, and select this folder." "3. 開いたページの左側「開発者モード」をオンにし、「展開して読み込み」でこのフォルダーを選びます。"
  !insertmacro ConnectorText $ConnectorTip "Done! Reload the page with the image, then right-click the image and choose Save to ImageStorage." "完了です。画像のあるページを再読み込みし、画像を右クリック →「ImageStorageに保存…」で送れます。"
  Call ShowBrowserConnectorGuide
FunctionEnd

Function ShowZenConnectorGuide
  ${If} $ConnectorZenSelected != ${BST_CHECKED}
    Abort
  ${EndIf}
  StrCpy $ConnectorBrowser "Zen"
  StrCpy $ConnectorBrowserExe $ConnectorZenExe
  StrCpy $ConnectorAddress "about:debugging#/runtime/this-firefox"
  StrCpy $ConnectorPath "$INSTDIR\browser-connector\zen\manifest.json"
  StrCpy $ConnectorFolder "$INSTDIR\browser-connector\zen"
  !insertmacro ConnectorText $ConnectorLoadStep "3. On that page, click Load Temporary Add-on and select this manifest.json file." "3. 開いたページで「一時的なアドオンを読み込む」を押し、この manifest.json を選びます。"
  !insertmacro ConnectorText $ConnectorTip "Done! Reload the image page. Zen removes this temporary add-on when it restarts, so load it again after restarting." "完了です。画像のあるページを再読み込みしてください。Zenを再起動すると一時アドオンは外れるので、そのときは再度読み込んでください。"
  Call ShowBrowserConnectorGuide
FunctionEnd

Function ShowBrowserConnectorGuide
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  !insertmacro ConnectorText $1 "Set up the $ConnectorBrowser extension" "$ConnectorBrowser に拡張機能を導入する"
  !insertmacro ConnectorText $2 "Follow steps 1 to 3. The buttons do the copying and opening for you." "1〜3の順に進めてください。ボタンでコピーや画面を開く操作ができます。"
  !insertmacro MUI_HEADER_TEXT "$1" "$2"

  !insertmacro ConnectorText $1 "1. Click the button, then click 連携を設定 in the window that opens." "1. ボタンを押し、開いた画面で「連携を設定」を押します。"
  ${NSD_CreateLabel} 0 0 100% 11u "$1"
  Pop $0
  !insertmacro ConnectorText $1 "Open connection setup" "連携設定を開く"
  ${NSD_CreateButton} 0 12u 110u 15u "$1"
  Pop $0
  ${NSD_OnClick} $0 OpenConnectorSetup

  !insertmacro ConnectorText $1 "2. Open the extensions page in $ConnectorBrowser." "2. $ConnectorBrowser で拡張機能のページを開きます。"
  ${NSD_CreateLabel} 0 33u 100% 11u "$1"
  Pop $0
  ${NSD_CreateText} 0 46u 56% 13u "$ConnectorAddress"
  Pop $ConnectorAddressText
  SendMessage $ConnectorAddressText ${EM_SETREADONLY} 1 0
  !insertmacro ConnectorText $1 "Copy" "コピー"
  ${NSD_CreateButton} 58% 45u 17% 15u "$1"
  Pop $0
  ${NSD_OnClick} $0 CopyConnectorAddress
  !insertmacro ConnectorText $1 "Open in $ConnectorBrowser" "$ConnectorBrowser で開く"
  ${NSD_CreateButton} 77% 45u 23% 15u "$1"
  Pop $0
  ${NSD_OnClick} $0 OpenConnectorAddress
  ${If} $ConnectorBrowserExe == ""
    EnableWindow $0 0
  ${EndIf}

  ${NSD_CreateLabel} 0 65u 100% 20u "$ConnectorLoadStep"
  Pop $0
  ${NSD_CreateText} 0 87u 56% 13u "$ConnectorPath"
  Pop $ConnectorPathText
  SendMessage $ConnectorPathText ${EM_SETREADONLY} 1 0
  !insertmacro ConnectorText $1 "Copy" "コピー"
  ${NSD_CreateButton} 58% 86u 17% 15u "$1"
  Pop $0
  ${NSD_OnClick} $0 CopyConnectorPath
  !insertmacro ConnectorText $1 "Show folder" "フォルダーを表示"
  ${NSD_CreateButton} 77% 86u 23% 15u "$1"
  Pop $0
  ${NSD_OnClick} $0 OpenConnectorFolder

  ${NSD_CreateLabel} 0 107u 100% 24u "$ConnectorTip"
  Pop $0

  nsDialogs::Show
FunctionEnd

Function OpenConnectorSetup
  Pop $0
  ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\browser-connector\SetupConnector.exe" "open" ""
  ${If} $0 == "error"
    !insertmacro ConnectorText $1 "Could not open connection setup. Run SetupConnector.exe from the browser-connector folder." "連携設定を開けませんでした。browser-connector フォルダーの SetupConnector.exe を開いてください。"
    MessageBox MB_OK|MB_ICONEXCLAMATION "$1"
  ${EndIf}
FunctionEnd

Function CopyConnectorAddress
  Pop $0
  SendMessage $ConnectorAddressText ${EM_SETSEL} 0 -1
  SendMessage $ConnectorAddressText ${WM_COPY} 0 0
FunctionEnd

Function CopyConnectorPath
  Pop $0
  SendMessage $ConnectorPathText ${EM_SETSEL} 0 -1
  SendMessage $ConnectorPathText ${WM_COPY} 0 0
FunctionEnd

Function OpenConnectorAddress
  Pop $0
  ${StdUtils.ExecShellAsUser} $0 "$ConnectorBrowserExe" "open" '"$ConnectorAddress"'
  ${If} $0 == "error"
    !insertmacro ConnectorText $1 "Could not open $ConnectorBrowser. Copy the address and paste it into the address bar." "$ConnectorBrowser を開けませんでした。アドレスをコピーして、アドレス欄に貼り付けてください。"
    MessageBox MB_OK|MB_ICONEXCLAMATION "$1"
  ${EndIf}
FunctionEnd

Function OpenConnectorFolder
  Pop $0
  ${StdUtils.ExecShellAsUser} $0 "$ConnectorFolder" "open" ""
FunctionEnd

Function OpenConnectorReadme
  Pop $0
  ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\browser-connector\使い方.txt" "open" ""
FunctionEnd
!macroend
!endif
