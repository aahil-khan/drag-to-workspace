UUID := edge-toss@aahil-khan.github.com
EXT_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: test schemas e2e install uninstall pack

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

pack: schemas
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist --extra-source=lib --schema=schemas/org.gnome.shell.extensions.edge-toss.gschema.xml .
