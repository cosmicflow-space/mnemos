# Mnemos install demo — terminal portion of the install GIF.
#
# Renders at the FINAL output size (1400x700) so there's no scaling
# afterwards — eliminates the wide letter-spacing artifact that scaling
# down a 2400×1200 render produced.
#
# Re-render anytime via:   vhs docs/demo/install.tape
# Output:                  docs/demo/install-terminal.gif

Output "docs/demo/install-terminal.gif"

Set Shell "bash"
Set FontFamily "Menlo"
Set FontSize 22
Set Width 1400
Set Height 700
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set Padding 24
Set LineHeight 1.2

# Hidden setup: source the stub shim + cd to a fresh workspace dir.
Hide
Type "source docs/demo/demo-init.sh"
Enter
Type "cd /tmp && rm -rf mnemos-demo && mkdir -p mnemos-demo/mnemos && cd mnemos-demo && clear"
Enter
Show

Sleep 500ms

# Typed clone command (no-op via alias)
Type "git clone https://github.com/cosmicflow-space/mnemos.git"
Sleep 250ms
Enter

Sleep 400ms

# Typed setup command (triggers mock-setup.sh via the `node` function)
Type "cd mnemos && node setup.mjs"
Enter

Sleep 6000ms
