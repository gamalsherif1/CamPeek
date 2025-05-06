# CamPeek@gamalsherif1.github.io/Makefile

all: compile-schemas

compile-schemas:
	mkdir -p schemas
	glib-compile-schemas schemas/

install: compile-schemas
	mkdir -p ~/.local/share/gnome-shell/extensions/CamPeek@gamalsherif1.github.io
	cp -r * ~/.local/share/gnome-shell/extensions/CamPeek@gamalsherif1.github.io/

uninstall:
	rm -rf ~/.local/share/gnome-shell/extensions/CamPeek@gamalsherif1.github.io

clean:
	rm -f schemas/*.compiled

.PHONY: all compile-schemas install uninstall clean
