# T3 Code (shiftynick) local desktop setup

Reproduces this machine's setup on another omarchy box: a one-shot launcher that
builds the local `shiftynick` fork only when its inputs or outputs changed, then
opens the built desktop app. It shows up in the app menu as **T3 Code (shiftynick)**.

## Files

- `t3code-shiftynick` — the launcher. Installed to `~/.local/bin/t3code-shiftynick`.
- `t3code-shiftynick.desktop` — reference app-menu entry for this machine.
- `install.sh` — copies the launcher and generates a desktop entry pointing at your repo.

## Install

Prereqs, same as the dev env: `mise` with `node@24.20.0`, `vp` at
`~/.vite-plus/bin/vp`, `notify-send`, `systemd-run`. The repo must already be
checked out and on the `shiftynick` branch with `vp i` done.

```bash
./shiftynick/install.sh            # repo defaults to ~/Work/t3code
./shiftynick/install.sh /path/to/repo   # for a non-default checkout
```

Then launch **T3 Code (shiftynick)** from the app menu.

## How the launcher works

- Refuses to run unless the repo is on `shiftynick`.
- Hashes every tracked and untracked source file (plus the script itself) and, on
  the output side, every built file under `apps/{desktop,server,web}/dist`. Both
  digests are saved to `<repo>/.t3/desktop-build.json`.
- If nothing changed it skips straight to launching; otherwise it runs
  `vp install --frozen-lockfile`, `vp run build:desktop`, and
  `apps/desktop/scripts/ensure-electron-runtime.mjs`. A failed or changing build
  never launches — the stamp is invalidated first and re-verified after.
- The app starts via `systemd-run --user` as `t3code-shiftynick-desktop.service`
  (unit name in the launcher), so it survives the launcher terminal closing.
  `T3CODE_HOME` is set to `<repo>/.t3`, keeping build and app state inside the worktree.
- A file lock (`<repo>/.t3/desktop-launch.lock`) is held for the app's lifetime,
  so double-launching pops a `notify-send` instead of stacking builds.

## Notes

- The desktop entry runs the launcher inside an `omarchy launch terminal` window
  so build progress is visible; the terminal closes once the app detaches.
- If a launch fails, errors go to `notify-send` and the log at
  `<repo>/.t3/desktop-build.log` (build) or `<repo>/.t3/desktop-launch.log` (run).
- To update after pulling new code, just launch it again — it rebuilds only if
  something changed.
