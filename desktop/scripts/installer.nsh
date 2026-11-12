!ifndef BUILD_UNINSTALLER
!include "nsDialogs.nsh"

Var ConnectorChromeCheck
Var ConnectorZenCheck
Var ConnectorChromeSelected
Var ConnectorZenSelected
Var ConnectorBrowser
Var ConnectorAddress
Var ConnectorPath
Var ConnectorLoadStep
Var ConnectorTip

!macro ConnectorText output english japanese
  ${If} $LANGUAGE == 1041
    StrCpy ${output} "${japanese}"
  ${Else}
    StrCpy ${output} "${english}"
  ${EndIf}
!macroend

!macro customFinishPage
  Page custom ChooseBrowserConnectors SaveBrowserConnectorChoices
  Page custom ShowChromeConnectorGuide
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
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  !insertmacro ConnectorText $1 "Browser extensions" "ブラウザー拡張機能"
  !insertmacro ConnectorText $2 "Choose the browsers you want to connect to ImageStorage." "ImageStorageと連携するブラウザーを選んでください。"
  !insertmacro MUI_HEADER_TEXT "$1" "$2"

  !insertmacro ConnectorText $1 "Select a browser to see how to add the ImageStorage extension and send images from its right-click menu." "ブラウザーを選ぶと、右クリックから画像を送るための拡張機能の導入手順が表示されます。"
  ${NSD_CreateLabel} 0 0 100% 30u "$1"
  Pop $0

  ${NSD_CreateCheckBox} 0 39u 100% 13u "Chrome"
  Pop $ConnectorChromeCheck
  ${If} $ConnectorChromeSelected == ${BST_CHECKED}
    ${NSD_Check} $ConnectorChromeCheck
  ${EndIf}
  ${NSD_CreateCheckBox} 0 61u 100% 13u "Zen"
  Pop $ConnectorZenCheck
  ${If} $ConnectorZenSelected == ${BST_CHECKED}
    ${NSD_Check} $ConnectorZenCheck
  ${EndIf}

  !insertmacro ConnectorText $1 "To skip browser setup, leave both boxes clear and click Next." "拡張機能を使わない場合は、チェックを入れずに「次へ」を押してください。"
  ${NSD_CreateLabel} 0 89u 100% 29u "$1"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function SaveBrowserConnectorChoices
  ${NSD_GetState} $ConnectorChromeCheck $ConnectorChromeSelected
  ${NSD_GetState} $ConnectorZenCheck $ConnectorZenSelected
FunctionEnd

Function ShowChromeConnectorGuide
  ${If} $ConnectorChromeSelected != ${BST_CHECKED}
    Abort
  ${EndIf}
  StrCpy $ConnectorBrowser "Chrome"
  StrCpy $ConnectorAddress "chrome://extensions/"
  StrCpy $ConnectorPath "$INSTDIR\browser-connector\chromium"
  !insertmacro ConnectorText $ConnectorLoadStep "3. Turn on Developer mode, click Load unpacked, and select this folder." "3. 「デベロッパーモード」をオンにして、「パッケージ化されていない拡張機能を読み込む」から下のフォルダーを選びます。"
  !insertmacro ConnectorText $ConnectorTip "After loading the extension, reload the page with the image you want to save." "拡張機能を読み込んだら、画像のあるページを再読み込みしてください。"
  Call ShowBrowserConnectorGuide
FunctionEnd

Function ShowZenConnectorGuide
  ${If} $ConnectorZenSelected != ${BST_CHECKED}
    Abort
  ${EndIf}
  StrCpy $ConnectorBrowser "Zen"
  StrCpy $ConnectorAddress "about:debugging#/runtime/this-firefox"
  StrCpy $ConnectorPath "$INSTDIR\browser-connector\zen\manifest.json"
  !insertmacro ConnectorText $ConnectorLoadStep "3. Click Load Temporary Add-on and select this manifest.json file." "3. 「一時的なアドオンを読み込む」を押して、下の manifest.json を選びます。"
  !insertmacro ConnectorText $ConnectorTip "Reload the image page. Zen removes this temporary add-on when it restarts." "画像のあるページを再読み込みしてください。Zenを再起動すると一時アドオンは外れます。"
  Call ShowBrowserConnectorGuide
FunctionEnd

Function ShowBrowserConnectorGuide
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  !insertmacro ConnectorText $1 "Connect $ConnectorBrowser" "$ConnectorBrowser の導入手順"
  !insertmacro ConnectorText $2 "You can select and copy the address and path below." "下のアドレスとパスは選択してコピーできます。"
  !insertmacro MUI_HEADER_TEXT "$1" "$2"

  !insertmacro ConnectorText $1 "1. Open PC connection setup, then click 連携を設定." "1. 下のボタンを押し、開いた画面で「連携を設定」を押します。"
  ${NSD_CreateLabel} 0 0 100% 12u "$1"
  Pop $0
  !insertmacro ConnectorText $1 "Open connection setup" "連携設定を開く"
  ${NSD_CreateButton} 0 14u 128u 16u "$1"
  Pop $0
  ${NSD_OnClick} $0 OpenConnectorSetup

  !insertmacro ConnectorText $1 "2. Open this address in $ConnectorBrowser." "2. $ConnectorBrowser のアドレス欄で下のアドレスを開きます。"
  ${NSD_CreateLabel} 0 39u 100% 11u "$1"
  Pop $0
  ${NSD_CreateText} 0 51u 100% 13u "$ConnectorAddress"
  Pop $0
  SendMessage $0 ${EM_SETREADONLY} 1 0

  ${NSD_CreateLabel} 0 71u 100% 24u "$ConnectorLoadStep"
  Pop $0
  ${NSD_CreateText} 0 97u 100% 13u "$ConnectorPath"
  Pop $0
  SendMessage $0 ${EM_SETREADONLY} 1 0
  ${NSD_CreateLabel} 0 118u 100% 22u "$ConnectorTip"
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
!macroend
!endif
