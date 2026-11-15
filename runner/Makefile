.PHONY: test install check

# The runner's tests: the system Python the LaunchAgent runs (3.9 on the Mac mini), standard library only.
test:
	python3 -m unittest discover -s tests -t .

# On Jais-Mac-mini, as jai: install or update the LaunchAgent com.jai.feedbackkit-runner from this checkout.
install:
	/usr/bin/python3 install.py

check:
	/usr/bin/python3 install.py --check
