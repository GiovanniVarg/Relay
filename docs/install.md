# Install Relay on Windows

Relay is a beta. The downloadable Windows x64 installer handles its private runtime and components automatically; you do not need a terminal, a system Node installation or a global CLI installation.

1. Download **Relay Setup** from the [latest beta release](https://github.com/GiovanniVarg/Relay/releases).
2. Open the executable and choose **Install Relay**. The first install needs internet, at least 5 GB of free space and a few minutes. Windows may show its normal unsigned-publisher security prompt; Relay does not install a certificate or disable Windows security.
3. Choose **Open Relay**, then connect your accounts through their official sign-in. Installation never signs you in, reads account credentials, sends model requests or approves model usage.

Setup puts application files in your Windows home folder's `Relay` directory and saved data in the separate `.relay-data` directory. Node, npm, Codex and Claude live privately beneath `Relay/.runtime`; they do not replace system programs or modify global PATH. Cursor's SDK and other app components are obtained through the locked official npm packages. The bot browser comes from Playwright's pinned browser download. Team execution uses the verified Herdr runtime.

Desktop and Start Menu shortcuts open Relay. **Start Relay when I sign in** is optional and unchecked by default. The native launcher uses Relay's existing independent supervisor, so closing the browser does not stop the hosting process.

An existing ready Relay installation is opened rather than overwritten. Apply normal checked updates through Relay. An unmarked, partial or linked destination is refused so setup cannot overwrite unrelated files. Setup removes its own temporary downloads after confirmed completion or failure. If Windows cannot confirm process cleanup, setup retains the private staging folder for diagnosis and blocks retry; your saved chats and credentials are not replaced.

To remove Relay, use Windows **Settings → Apps → Relay (Beta) → Uninstall**. The uninstaller verifies the owned application, stops only its verified process and removes its application files and matching shortcuts. It retains saved chats, account profiles and encrypted credentials in `.relay-data`. An unconfirmed process or linked installation causes removal to stop for inspection.

The current installer targets Windows x64. macOS and physical iPhone behavior have separate validation requirements; the phone is a paired controller, not a desktop installer target. See [QR connection setup](qr-pairing.md).

## Build a release

Build only from a clean public `GiovanniVarg/Relay` checkout. Never package an operator's existing `node_modules`, browser cache, `.runtime`, account profiles or private historical reports. Run the documented source dependency/type/build checks, then:

```powershell
powershell.exe -NoProfile -File scripts/installer/build-windows.ps1 -SourceRoot . -OutputDirectory .artifacts-release
```

The Windows .NET Framework compiler builds the native GUI. Output includes the beta setup executable, `SHA256SUMS.txt`, component/source metadata and third-party notices. Provider runtimes are downloaded on the installing user's computer; they are not relabeled or redistributed under Relay's MIT license. The source/build payload is bounded and hash-verified before any execution.

Automated installation verification supports separate `--destination`, `--data`, `--port`, `--no-integrations` and `--browser-cache` arguments. These isolate test installations from normal Relay, Desktop/Start Menu/Startup and registry settings. This is test infrastructure rather than the normal user setup flow.
