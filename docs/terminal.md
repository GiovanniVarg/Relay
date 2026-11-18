# Terminal inside Relay

Relay includes an embedded terminal. Windows shell behavior has been exercised; native macOS/Linux behavior still needs platform verification. This beta source snapshot does not claim production readiness.

## Open and start

Select **Terminal** in Relay's sidebar, choose an installed shell, then select **Start terminal**. Advanced mode and a connected model are not required. The terminal runs inside Relay; it does not open an external terminal window. Opening the panel or selecting a shell does not start a process.

On Windows, the shell list includes installed Command Prompt and Windows PowerShell, with PowerShell 7 when available. On macOS and Linux, Relay lists available supported system shells. Your preferred shell is remembered separately for each OS. Change shells after closing the current session and explicitly starting another. Native macOS/Linux operation has not been verified on this Windows development host.

At Start, Relay uses the selected bot's saved workspace, or your detected home folder when no workspace is set. An invalid saved workspace produces an error instead of silently choosing another location. This is the session's starting directory: changing bots, groups or workspace settings later does not move or replace its shell.

The terminal is global to your signed-in Relay operator session. It remains running when you hide its dock, switch chats or view the bot's Browser. Browser and Terminal share one visible utility pane. On mobile, Terminal uses a drawer; Escape is passed to the shell rather than closing the drawer.

## Input, interruption and closing

Type or paste commands yourself. **Interrupt** sends Ctrl+C; a program determines how it responds. **Close** hides the terminal view. **Close session** requests termination of the owned shell. A confirmed shell exit does not prove that every intentionally detached or background child process stopped. Unconfirmed cleanup remains visible and continues to count as active work.

Relay permits one terminal per operator session and at most four starting, running or uncertain terminals across the server. Another tab cannot simultaneously control the same terminal. Active or uncertain sessions delay Relay updates until their activity is resolved.

A connection error disables input. Use **Reconnect** explicitly; Relay never automatically resends uncertain keystrokes or commands. Use **Refresh state** when offered to reconcile a possibly started or disconnected session before starting another. Another Relay tab may already hold the connection. Output is retained only within bounded memory. If reconnect cannot recover a complete output sequence, the display resets with a visible gap warning and follows new output. Reconnect can also recover retained output after shell exit. Do not treat a disconnected or incomplete view as a complete transcript.

## Permissions, history and tools

This is a normal shell running with your OS-user permissions, not an OS sandbox. Its starting folder does not confine filesystem or command access. Explicit Start authorizes the shell's normal startup configuration and profiles. Relay does not request elevation for it. Shell-managed history follows that shell's OS configuration; Relay does not save a terminal transcript or keystrokes to chats, application logs, backups or model context.

Terminal output is untrusted text rendered by a locally bundled terminal engine. Output-triggered clipboard operations, window actions and hyperlink activation are disabled. Manual typing and pasting remain available. Relay does not expose this human terminal as a model-callable shell tool or automatically run AI-generated commands.

You can manually launch an ordinarily installed CLI, including Claude or Codex, as you would in another terminal. Its installation, authentication, permissions and billing remain its own; starting it does not establish a Relay account connection or supported subscription entitlement.

Relay bundles xterm and its fitting support with an optional native node-pty engine. The native binding runs in a separate Relay-owned helper process; Windows uses its official DLL mode. Relay requires native shell-exit acknowledgement and actual helper closure before confirming cleanup. It does not patch the vendor or fall back to the earlier in-process/default Windows path. If the native engine is unavailable, Terminal reports that limitation while ordinary Relay use remains available.

Disposable Windows Command Prompt and PowerShell tests have exercised commands, working directory, resize, interruption, natural exit and owned cleanup. The actual built client has also exercised Command Prompt through authenticated HTTP/SSE, including keyboard input, viewport resize, hidden-running persistence and Close session. These no-profile/history-isolated fixtures do not establish your personal startup-profile behavior. Unix discovery has fixture coverage only; native macOS/Linux execution and detached-child termination remain unproved.
