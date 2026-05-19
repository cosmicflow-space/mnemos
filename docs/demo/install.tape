# Mnemos install demo — terminal portion of the install GIF.
#
# Strategy: source docs/demo/demo-init.sh which aliases `git` to no-op
# and overrides `node` to invoke our mock-setup.sh when called with
# setup.mjs. This means the user types real commands but no real
# clone/install happens — clean, deterministic, network-free recording.
#
# Re-render anytime via:   vhs docs/demo/install.tape
# Output:                  docs/demo/install-terminal.gif

Output "docs/demo/install-terminal.gif"

Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 22
Set Width 1200
Set Height 600
Set Theme "Catppuccin Mocha"
Set TypingSpeed 50ms
Set Padding 20

# Hidden setup: source the stub shim + cd to a fresh workspace dir.
Hide
Type "source /Users/sammuthu/Projects/mnemos/docs/demo/demo-init.sh"
Enter
Type "cd /tmp && rm -rf mnemos-demo && mkdir -p mnemos-demo/mnemos && cd mnemos-demo && clear"
Enter
Show

Sleep 600ms

# Typed clone command (no-op via alias)
Type "git clone https://github.com/cosmicflow-space/mnemos.git"
Sleep 300ms
Enter

Sleep 600ms

# Typed setup command (triggers mock-setup.sh via the `node` function)
Type "cd mnemos && node setup.mjs"
Enter

# Wait for mock script output (~5s of internal sleeps + 1s final pause)
Sleep 6500ms
