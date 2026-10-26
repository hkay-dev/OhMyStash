---
title: Install and update
feature: install
covers:
  - package.json
since: 2026-08-22
description: What OhMyStash needs, how to install, pin and update it, and how to check it.
sidebar:
  order: 1
---

OhMyStash installs straight from GitHub with OMP's plugin manager. There's no separate installer and no custom OMP build.

## What you need

- OMP 18.12.1 or newer.
- Bun on your PATH. OMP's plugin manager installs packages with Bun.

On macOS, install Bun with Homebrew:

```sh
brew install bun
```

On Linux and Windows, follow the install steps at [bun.sh](https://bun.sh).

OMP installs the standard SDK packages OMS depends on for you.

## Install

1. Run this in a terminal:

   ```sh
   omp plugin install github:hkay-dev/OhMyStash
   ```

2. Restart OMP.
3. Open the stash browser with `Alt+Shift+S` or `/stash`.

## Pin a version

To stay on one release, add its tag to the address. This pins version 1.15.0:

```sh
omp plugin install github:hkay-dev/OhMyStash#v1.15.0
```

## Update

Run the install again with `--force`:

```sh
omp plugin install --force github:hkay-dev/OhMyStash
```

Restart OMP afterward. Your stashes stay where they are.

## Check the install

`omp plugin doctor` checks the installed package and its extension:

```sh
omp plugin doctor @hkay-dev/ohmystash
```

`@hkay-dev/ohmystash` is the plugin's ID in OMP. It's also the name its settings and diagnostics use. See [Settings](settings.md).

## If OMP says to restart

OMS attaches to OMP's native editor so it can read images and large pastes in your composer. If OMP started before the plugin was fully attached, stashing or restoring a prompt with those can show this message:

```
Restart OMP once so OhMyStash can attach to the native editor
```

Close OMP and open it again. You only need to do it once after an install or update. Other restart messages are listed in [Messages and fixes](troubleshooting.md).

Next, [stash your first prompt](stash-and-restore.md).
