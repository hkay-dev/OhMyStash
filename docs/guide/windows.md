---
title: Windows
feature: windows
covers:
  - extensions/storage-permissions.ts
  - extensions/storage-permissions.ps1
  - extensions/build-storage-worker.ps1
  - extensions/storage-acl-server.cs
  - extensions/storage-acl-transport.mjs
since: 2026-08-22
description: How OhMyStash keeps its folders private on Windows, and the optional permission worker that makes storage actions faster.
sidebar:
  order: 11
---

OhMyStash works the same on Windows as on macOS and Linux. The one difference is how it keeps your stashes private to your account.

## Private folders

On macOS and Linux, OhMyStash checks folder permissions. On Windows it checks who has access to the stash folder, the attachments folder and the files inside them. It only uses them when your account is the only one with access. New folders are created that way, so you usually don't have to do anything.

If a folder lets other accounts in, for example after you moved it from somewhere else, OhMyStash stops and says:

```text
OMS failed: OMS storage directory ... must be private to your account (...). Remove other accounts from its Security settings
```

To fix it:

1. Open the folder named in the message in File Explorer.
2. Right-click it and choose **Properties**, then open the **Security** tab.
3. Leave only your own account in the list.
4. Try the stash again.

The message for a single stash file works the same way. See [Messages and fixes](troubleshooting.md) for the other messages.

## The permission checks

By default, OhMyStash asks a small PowerShell helper to do these checks. That starts PowerShell for each storage action, which is slower than it needs to be.

The helper keeps a compiled copy of its checks in the stash folder, in a file named `.storage-permissions-<hash>.dll`. It's safe to delete. OhMyStash builds it again the next time it needs it.

## The optional permission worker

The worker is a small program that stays running for the whole OMP session, so OhMyStash doesn't launch PowerShell for each action. It does the same checks as the helper on every request. It doesn't remember earlier answers and it doesn't skip any disk safety steps. It talks to OhMyStash over a private channel that only your Windows account can open.

You don't need it. Without it, OhMyStash keeps using the PowerShell helper.

### Build it

You need Windows, PowerShell 7 and the .NET Framework C# compiler that comes with Windows. From the installed plugin's folder, run:

```powershell
pwsh -NoProfile -File ./extensions/build-storage-worker.ps1
```

Then start a new OMP session.

The build writes only the worker program and its source next to the other extension files. It never changes your stashes or their permissions. If a worker is already there, the build refuses to replace it. Quit OMP, move the old worker aside, and build again.

### Turn it off

To use the PowerShell helper even though a worker is built, set `OMS_ACL_TRANSPORT` to `oneshot` before you start OMP:

```powershell
$env:OMS_ACL_TRANSPORT = "oneshot"
```

The worker only runs on Windows. Nothing changes on macOS or Linux.
