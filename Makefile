UUID := edge-toss@aahil-khan.github.com
EXT_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: test schemas e2e install uninstall pack matrix

test:
	node --test test/logic.test.js

schemas:
	glib-compile-schemas schemas

e2e: schemas
	test/e2e/run.sh

# A symlink, so edits in this repo are what the shell loads at next login.
install: schemas
	mkdir -p $(dir $(EXT_DIR))
	ln -sfn $(CURDIR) $(EXT_DIR)

uninstall:
	rm -f $(EXT_DIR)

# One zip per range of GNOME versions.
pack:
	scripts/pack.sh

# The end-to-end tests against each zip, on the distros it targets, in containers.
matrix: pack
	test/e2e/matrix.sh
