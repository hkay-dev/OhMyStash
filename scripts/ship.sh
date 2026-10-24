#!/bin/sh
# Ship it (`tend ship`): refuse a dirty tree, run the checks, pack HEAD and install it into OMP on
# this Mac. Tend pushes main afterwards, so this script never pushes the repo and never tags.
# The public GitHub release (tag, release notes) stays manual: docs/releasing.md.
# The install follows ~/.agents/skills/omp-plugin-audit/reference/live-install.md. It always
# installs HEAD into a new local-builds folder, even when package.json's version is already installed.
# Dotfiles gets a commit here but no push: push ~/Development/workspaces/dotfiles after a ship.
# The TUI checks (open the changed UI, the installed-runtime proof) stay the agent's job before Done.
set -eu

fail() { echo "ship: $*" >&2; exit 1; }

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"

[ "$(git branch --show-current)" = main ] || fail "not on main"
[ -z "$(git status --porcelain)" ] || fail "uncommitted changes in $repo"

name=$(jq -r .name package.json)
short=${name#@hkay-dev/}
version=$(jq -r .version package.json)
head=$(git rev-parse HEAD)

echo "== checks"
bun install --frozen-lockfile
bun run check
bun test --timeout 60000 tests/ui.test.ts tests/browser-ui.test.ts

echo "== pack $name@$version ($head)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/src"
git archive HEAD | tar -x -C "$tmp/src"
(cd "$tmp/src" && npm pack --ignore-scripts --pack-destination "$tmp" >/dev/null)
tgz=$(ls "$tmp"/*.tgz)
extra=$(tar -tzf "$tgz" | grep -v -e '^package/package.json$' -e '^package/extensions/' || true)
[ -z "$extra" ] || fail "the pack has more than package.json and extensions/: $extra"

echo "== install $name@$version"
omp_version=$(omp --version | sed 's#^omp/##')
P="$HOME/.omp/plugins"
B="$P/local-builds/$omp_version"
n=2
while [ -e "$B" ]; do B="$P/local-builds/$omp_version-$n"; n=$((n + 1)); done
mkdir -p "$B"
cp "$tgz" "$B/"
jq -n --arg name "$name" --arg tgz "file:./$(basename "$tgz")" --arg v "$omp_version" '{
  private: true,
  dependencies: {
    ($name): $tgz,
    "@oh-my-pi/pi-agent-core": $v, "@oh-my-pi/pi-ai": $v, "@oh-my-pi/pi-coding-agent": $v,
    "@oh-my-pi/pi-tui": $v, "@oh-my-pi/pi-utils": $v
  }
}' >"$B/package.json"
(cd "$B" && bun install --production --ignore-scripts)
[ "$(jq -r .version "$B/node_modules/$name/package.json")" = "$version" ] || fail "$B didn't install $version"

L="$P/node_modules/$name"
printf '%s\t%s\n' "$short" "$(readlink "$L")" >>"$P/local-builds/symlinks-before-$(basename "$B").tsv"
# macOS mv: -h renames over the symlink instead of moving into the folder it points to (no GNU -T here).
ln -sfn "$B/node_modules/$name" "$L.new" && mv -h "$L.new" "$L"

lock="$P/omp-plugins.lock.json"
cp -p "$lock" "$lock.bak-$(date +%Y-%m-%d)-$short-$version"
jq --arg name "$name" --arg v "$version" '.plugins[$name].version = $v' "$lock" >"$lock.new" && mv "$lock.new" "$lock"
omp plugin doctor --json | jq -r --arg name "$name" '.[] | select(.name == $name) | "\(.status) \(.name) \(.message)"'

echo "== record in chezmoi"
D="$HOME/Development/workspaces/dotfiles"
tmpl="dot_omp/plugins/node_modules/@hkay-dev/symlink_$short.tmpl"
printf '{{ .chezmoi.homeDir }}/.omp/plugins/local-builds/%s/node_modules/%s\n' "$(basename "$B")" "$name" >"$D/$tmpl"
chezmoi re-add "$lock"
git -C "$D" add -- "$tmpl" dot_omp/plugins/omp-plugins.lock.json
git -C "$D" commit -m "chore(omp): install $short $version" -- "$tmpl" dot_omp/plugins/omp-plugins.lock.json

echo "shipped $name@$version ($head). Dotfiles has a commit that needs a push. New OMP sessions load it; restart open ones."
