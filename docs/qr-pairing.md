# QR pairing without system certificate installation

Relay connects the hosted controller directly to the enabled host over a QR-pinned encrypted LAN connection. The QR includes public host identity and the current transport certificate hash; it contains no private key or subscription credential.

## Connect

Open the phone button in Relay, enable local connections if needed, and wait for the QR connection to become ready. Scan the current QR with your device, allow its ordinary Local Network permission if requested, then enter a new one-time connection code from the host. Save a host name and leave automatic reconnect enabled to resume it when you reopen the controller on the matching network.

On iPhone, choose where you will keep using Relay before pairing. Safari and a Home Screen app have separate browser storage: pairing in Safari does not pair the installed app. Choose **Continue in Safari** to check the computer and pair in that browser. To use the Home Screen app, choose **Set up Home Screen app**, then **Copy setup details**. Installation is a separate view with a **Back** button; it does not leave competing connection actions underneath. Use Safari’s Share → Add to Home Screen, open the new icon, paste into **Copied connection profile**, and choose **Use copied connection profile**. Check the connection and enter a fresh sync code inside that app once. The copied profile includes the public host certificate and transport pin, never the sync code or device signing key. Copy failures offer manual selection; Relay never reads the clipboard automatically.

The pairing screen asks only for the masked **Sync code**. Optional host/device names and the automatic reconnect preference are under **Connection details**. Saved hosts retain their access and reconnect status; Advanced contains address/profile import and explicit legacy certificate controls. A normal first-time transport startup says **Preparing your secure connection…** until its QR is ready; it is not an instruction to restart Relay. Actual transport failures are shown separately.

No root certificate installation is required for this path. The browser must support WebTransport certificate hashes; modern Chrome is verified. WebKit shipped the feature in Safari 26.4, but physical iPhone interoperability must still be checked on the user’s device. Unsupported browsers receive an update message and do not silently downgrade. Legacy HTTPS certificate setup remains explicitly available under Advanced for existing installations.

## Security and persistence

The public web host serves only the controller shell. Commands, images, pairing codes, device signatures and responses travel directly between the controller and the selected LAN host. Existing controller/worker roles, request signature, timestamp, nonce/replay, CSRF and revocation checks remain in the existing LAN authorization path. Worker setup keeps its existing HTTPS public-profile format.

Device signing keys remain nonextractable in browser storage. Host private keys use Relay’s OS-protected vault. Independent twelve-day certificate keys and exact certificates are stored in encrypted chunks with an atomically published encrypted manifest. A signed catalog provides about two years of future certificate pins and is refreshed on successful local connections. If a device stays disconnected beyond its saved trust horizon, scan a fresh QR. Profiles, catalog generations and per-window bindings prevent another host or stale window from taking over a request.

Relay asks the browser to retain its storage after opening a paired host. That request is best effort: refusal or lack of support never blocks the workspace, and the browser controls its storage policy. Closing and reopening the same app/browser keeps its saved pairing and automatic reconnect setting. Clearing its data, removing the app, host access revocation, or replacing the host identity can require pairing again. Browser or OS Local Network permission remains under the user's control. Apple documents that iOS installation copies cookies only, not other local storage: [WebKit features in Safari 17.2 — Web Apps](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/).

The native QUIC server listens only on loopback. A bounded UDP gateway on the selected private interface admits packets from its configured subnet and checks the interface again on every ingress and egress. This proves the address policy, not a physical Wi-Fi SSID. Do not expose Relay through router port forwarding. Windows/macOS may require an ordinary application firewall or Local Network approval for the enabled host. QR transport uses UDP on the same numeric port as legacy HTTPS (normally 3443).

The native component is version-pinned to 1.6.12. Missing prebuilds are obtained from the publisher’s fixed release with bounded HTTPS downloads and both archive and native SHA-256 verification, without running arbitrary install scripts or compiling locally. Supported prebuild hosts are Windows x64, macOS x64/arm64, and Linux x64/arm64.

## Failure behavior

Turning off or revoking device access terminates authenticated streams. A failed request is never automatically resent because the host may already have accepted it. Expired/tampered catalogs, bad certificate pins, changed identity, revoked credentials, wrong roles and changed window bindings fail closed. Initial encrypted certificate preparation may take up to two minutes on Windows; the existing local Relay remains available while it starts.

The pinned native component does not implement certificate hot reload. Relay rotates certificates by replacing its private connection backend and admitting a new listener before advertising the new pin. Remote views briefly reconnect during rotation; host jobs keep running. Old pending requests are cancelled and are not forwarded through the replacement backend.

Combined QR pairing attempts currently share the existing ten-attempts-per-minute bridge bucket, in addition to the global limit. This conservatively restricts rapid multi-device setup; it does not relax brute-force protection.

Primary platform references: https://www.w3.org/TR/webtransport/#server-authentication-using-certificate-hashes and https://webkit.org/blog/17862/webkit-features-for-safari-26-4/ .
