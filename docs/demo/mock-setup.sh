#!/usr/bin/env bash
# Simulated `node setup.mjs` output used by docs/demo/install.tape.
# The real setup.mjs is interactive and downloads dependencies — we
# simulate its visible behavior here for a clean, deterministic GIF.

GREEN='\033[32m'
CYAN='\033[36m'
BOLD='\033[1m'
RESET='\033[0m'

echo ""
echo "  Mnemos setup"
sleep 0.3
echo -e "    ${GREEN}✓${RESET}  Node 22.20.0 detected"
sleep 0.3
echo -e "    ${GREEN}✓${RESET}  pnpm 9.15.0 available"
sleep 0.3
echo -e "    ${GREEN}✓${RESET}  Created ~/.mnemos (chmod 700)"
sleep 0.4
echo ""
echo "  Pick your chat provider:"
echo -e "     ${BOLD}1${RESET}) ollama      local daemon on :11434  ${GREEN}no key · recommended${RESET}"
echo "     2) anthropic   Claude"
echo "     3) openai      GPT"
echo -e "  Choice [1-3, default 1]: ${BOLD}1${RESET}"
sleep 0.6
echo ""
echo -e "    ${GREEN}✓${RESET}  Dev server starting at ${CYAN}http://127.0.0.1:3030${RESET}"
sleep 1.0
