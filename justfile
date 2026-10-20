set shell := ["bash", "-euo", "pipefail", "-c"]

set positional-arguments

# default behaviour: alias for `list`
default: list

# show the recipe list
list:
    @just --list --unsorted

# install dependencies from bun.lock
install:
    bun install --frozen-lockfile

# start the server in the foreground (config: ${XDG_CONFIG_HOME:-~/.config}/bark-admin/config.toml)
run:
    bun run src/main.ts

# oxlint + tsc + justfile format check
lint:
    bunx oxlint --deny-warnings src test public
    bunx tsc -p .
    just --unstable --fmt --check

# bun test (ARGS e.g. `just test test/app.test.ts`)
test *ARGS:
    bun test "$@"

# lint + test (push gate)
check: lint test

# ---------- gates ----------

[private]
ensure-clean:
    bump-semver vcs is clean

[private]
check-on-default-branch:
    bump-semver vcs is on-default-branch

# push the default branch to origin after check
push: check-on-default-branch ensure-clean check
    bump-semver vcs push --branch "$(bump-semver vcs get default-branch)" --jj-bookmark-auto-advance
