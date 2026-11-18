# Connected Relay

Relay combines explicit background assignments, paired local-network controllers and computers, and separate subscription account profiles. Certificate-free controller QR pairing shipped in 0.10.0; the 0.10.1 source adds guidance for installing and reopening the iPhone controller.

## Assign from the conversation

Type @ and choose a bot or computer. The picker inserts a complete assignment token, such as @Worker: or @Render PC:. Add the task and send. Selecting a mention alone does not send. One source message owns the submission; each chosen bot receives its own Task, selected attachments, and a shared bounded reference capsule. View activity in the same conversation to read results, stop work, or answer worker questions. Normal messages without explicit tokens keep their usual behavior.

Context includes at most eight relevant completed source messages and 12,000 characters, prioritizing a selected reply. It excludes other bots’ private memory and instructions. A Markdown index points to attributed excerpts. Images and documents are copied as verified owned bytes into each assigned bot’s chat. Internal continuation records stay out of human message bubbles.

## Connect another device

Open the phone icon beside Settings, or Chat options → Devices & computers. Choose this host’s private IPv4 interface, enable local connections, and approve the exact controller website origin. Wait for the QR connection to become ready. A phone or browser needs its own short-lived one-time controller code. A worker computer needs a worker code instead. Codes expire after five minutes and are consumed once. Possessing a code does not bypass the same-subnet check.

Scan a fresh QR to open the controller with the host’s public identity and pinned transport certificate hash. The QR contains no private key or subscription credential. Supported browsers use this pin directly without installing a root certificate. Allow ordinary Local Network access if requested. Legacy HTTPS certificate setup remains available explicitly under Advanced; it is not the normal QR path.

On iPhone, open the QR in Safari and choose **Set up Home Screen app**, then **Copy public connection profile**. Use Safari’s **Share → Add to Home Screen**. Open the new icon, paste into **Copied connection profile** and choose **Use copied connection profile**. Continue with **Check connection**, enter a new sync code, then **Connect securely**. The copied profile contains only public host identity and transport information; it cannot sign requests or replace a sync code. Safari and the Home Screen app have separate storage, so pair in the app you intend to keep using. If you prefer Safari without installation, pair and keep using Safari. Installation requires Safari’s user action; Relay does not silently install a native app.

A paired host profile and nonextractable device signing key remain in IndexedDB. Keep automatic reconnect enabled and reopen the same controller app to resume on the matching network without entering another sync code. A temporarily sleeping or offline host does not by itself require pairing again. Local Network permission is still controlled by the browser/OS. Deleting app or website data, revocation, another browser/app storage context, a changed host identity/address, or an expired saved trust horizon may require recovery or a fresh QR/code. Persistent storage cannot override deliberate deletion or OS storage policy. See [QR pairing details](qr-pairing.md).

Vercel serves the static controller shell. QR-pinned encrypted connections carry signed API calls directly to the private LAN host; the legacy controller and worker path uses HTTPS. Chats, subscription credentials, and API keys are not uploaded to a Vercel backend. The hosting computer must be awake and reachable on the same network. An address change requires a new public connection profile. Network access is optional and does not replace the loopback listener or supervisor.

## Add a worker computer

In the Computer tab, download Relay Worker and keep its public connection profile with the extracted files. Run Setup Relay Worker.cmd on Windows or Setup Relay Worker.command on macOS. Node.js 22.13 or newer and npm must already be installed. Setup asks before downloading the pinned runtime dependencies; it does not install Node, provider CLIs, or browsers. Install any desired official CLI yourself. Verify the displayed fingerprint and enter the worker code at its prompt. Codes and private keys never go in process arguments.

Use the worker’s displayed loopback setup address to connect its own subscriptions and approve models and usage. Keep the worker window running. It advertises available models, including explicitly approved additional local accounts. Host account pins belong to the host; clear a bot’s account pin before assigning another computer. Provider/model preferences can remain explicit when that worker supports them. Host credentials and file-system paths are never transferred. The initial workspace alias is the worker user’s home.

Remote jobs stay on the selected machine. An offline target stays queued. Temporary network loss observes an already accepted job and never launches it again. A worker restart or uncertain process stop fences that machine until the existing effects are inspected; it is never automatically replayed. Revoking a disconnected device cannot prove that its already accepted work stopped.

## Multiple subscription accounts

Workspace settings → Subscription accounts → Add account creates a separate Claude, OpenAI/ChatGPT, or Cursor profile. Complete that account’s official sign-in, then Refresh account. Sign-in, usage approval, and enabled models are separate steps. New additional accounts start unapproved, outside Auto routing, and with no enabled models. Existing default profile locations and billing/model settings stay unchanged.

Each account has its own model catalog, usage identity, approval, and continuity/cache partition. A bot can pin an account; an advanced conversation can override that selection for one run. Clearing the conversation account selection does not edit the saved bot pin. Pinned accounts never fall back to a sibling account. Unpinned Auto may choose another eligible approved account after a suitable pre-output failure. Duplicate sign-ins share their provider’s allowance and are labeled accordingly; extra profiles do not create extra quota.

Disconnecting an additional account disables its Relay connection but retains the isolated native profile for deliberate inspection. Sign-in and disconnection are blocked while owned inference or unconfirmed cleanup still uses that account. Proven cleanup releases both execution and account lifecycle holds atomically.

## Security boundaries and validation limits

LAN requests use TLS 1.3, per-device P-256 signatures over exact request bytes, timestamp/nonce replay checks, and role separation. Controller mutations retain CSRF checks. Pairing codes are role-bound, time-bound and rate-limited. Revocation invalidates signed access and existing authenticated streams. Controllers have access to this user’s Relay tools, files and terminals: pair only trusted devices.

Server/worker private keys use Windows DPAPI or macOS Keychain with no plaintext fallback. Browser controller keys are nonextractable CryptoKeys stored in IndexedDB. HTTPS does not turn provider CLI Agent mode into an operating-system sandbox. Source changes still use isolated drafts, checks, backups, and the trusted updater.

Local tests exercise synthetic provider calls, real SQLite attachment ownership, real HTTPS/CA verification, QR-pinned native transport, signatures, roles, recovery, and browser service-worker streaming. Actual Windows/Chrome pairing and reload reconnection to the installed host were verified without a certificate import or browser TLS bypass. Browser fixture trust is confined to isolated test processes. Physical iPhone installation, close/reopen reconnection, macOS native credential-store behavior, and sign-in to additional real subscription accounts require testing on those devices. No live model requests are part of these checks.

Browser integration checks are explicit opt-ins. Run them with supported installed browsers and a private IPv4 interface; a default skipped browser test is not device verification.
