#!/usr/bin/env bash
# Demo environment setup — sourced from docs/demo/install.tape (VHS).
# Defines no-op stubs for the real commands the demo would otherwise
# invoke. The point is to render a clean terminal GIF without actually
# cloning the repo or running setup.mjs.

# `git` becomes a no-op — `git clone ...` types correctly but does nothing.
alias git=true

# `node setup.mjs` triggers our mock setup script (which prints the same
# output the real setup wizard would print, sans the interactivity).
# Any other `node` invocation falls through to the real node binary.
node() {
  if [ "$1" = "setup.mjs" ]; then
    bash "$(dirname "${BASH_SOURCE[0]}")/mock-setup.sh"
  else
    command node "$@"
  fi
}

# Clean prompt — no fancy zsh chrome, just a $ + space.
export PS1='$ '
