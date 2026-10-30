---
type: log
summary: Changed - Every OMP plugin now ships through one shared script that rolls back a bad install and clears out old builds.
project: ohmystash
sprint: syscleanup-10-plugins
window: 2026-10-30T20:26:45Z/2026-10-30T20:39:24Z
tickets: [ohmystash#wpyr]
---

# Systems cleanup 10: one way to ship plugins

Changed: Every OMP plugin now ships through one shared script that rolls back a bad install and clears out old builds.
Try: Press Ship it on Loop Mode in Deck first, then open a new OMP chat; not tried yet with a real ship. The first ship frees about 19 GB of old plugin builds.

## What changed

- Improved: Ship it uses the shared plugin ship script (ohmystash#wpyr)
