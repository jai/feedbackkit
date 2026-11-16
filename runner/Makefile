.PHONY: test install install-check

# The runner's tests, standard library only. The LaunchAgent runs Homebrew's Python 3.14 (install.py).
test:
	python3 -m unittest discover -s tests -t .

# On Jais-Mac-mini, as jai: install or update the LaunchAgent com.jai.feedbackkit-runner from this checkout.
install:
	/opt/homebrew/opt/python@3.14/bin/python3.14 install.py

# Not `check`: the root Makefile's `check` is the code check (jai/ci make targets).
install-check:
	/opt/homebrew/opt/python@3.14/bin/python3.14 install.py --check
