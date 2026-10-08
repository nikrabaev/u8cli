# The recording at the top of the README: docs/assets/dashboard.gif.
#
# Not run directly. `pnpm record` (scripts/record-dashboard.js) runs it from a
# throwaway directory that holds a copy of examples/demo, a `u8` on PATH and
# the setup.sh sourced below — which is why nothing in here names a path.
#
# The <img alt> beside the recording in README.md describes this storyline;
# change the two together. The two long sleeps are the stack coming up in
# dependency order, about 8.5s each: shorten them and the recording moves on
# before the last app is healthy.

Output dashboard.gif

Set Shell bash
Set FontSize 16
Set Width 1040
Set Height 540
Set Padding 24
Set WindowBar Colorful
Set Theme "Catppuccin Mocha"
Set TypingSpeed 90ms
Set Framerate 20

# Off screen: the PATH, the state dir and the prompt. A reader's first look at
# the tool should not be a wall of temp paths.
Hide
Type "source ./setup.sh" Enter
Type "clear" Enter
Sleep 1s
Show

# Base: open the dashboard and start the profile.
Sleep 700ms
Type "u8" Sleep 500ms Enter
Sleep 1800ms
Type "S"
Sleep 9500ms

# A second instance, made from the instance menu…
Type "i"
Sleep 1400ms
Type "n"
Sleep 900ms
Type@110ms "feat-x"
Sleep 1000ms
Enter
Sleep 3200ms
Enter
Sleep 900ms

# …and brought up, with the progress drawn on its rows.
Type "i"
Sleep 1300ms
Type "u"
Sleep 10s
Enter
Sleep 1200ms

# Both sections folded into the overview, and back.
Type "z"
Sleep 2000ms
Type "z"
Sleep 800ms

# The log view of the instance's first app, then the command palette.
Down
Sleep 400ms
Enter
Sleep 2400ms
Escape
Sleep 600ms
Type ":"
Sleep 900ms
Type@160ms "test"
Sleep 1500ms
Escape
Sleep 1800ms
