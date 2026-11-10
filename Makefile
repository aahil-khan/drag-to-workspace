UUID := drag-to-workspace@aahil-khan.github.com
EXT_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: test schemas e2e install uninstall pack matrix pot

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

# Regenerates the template that translations in po/ are made from.
pot:
	xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --add-comments \
		--package-name=drag-to-workspace --output=po/drag-to-workspace.pot \
		extension.js prefs.js lib/*.js prefs/*.js
