package main

import (
	"log"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// Agent Client GUI — a small desktop client that pairs this machine with one
// or more pi-web relays and keeps an agent-client connection per server. It
// is independent of the agent-client CLI: pairing/connecting shells out to
// the bundled agent-client binary, so the command-line workflow is unchanged.
func main() {
	a := newApp()

	// Follow the desktop's light/dark appearance. On Linux this also keeps
	// GTK's gtk-application-prefer-dark-theme in sync with the settings portal
	// (MyGo #1120 / PR #1123): a light desktop otherwise leaves GTK on its
	// dark default, which paints white text in a white native-UI window.
	mygo.Theme.SetSource(mygo.ThemeSystem)

	mygo.App.WhenReady(func() {
		// Settings load before the first frame, so the form shows the
		// last-used server and client name immediately.
		a.loadSettings()
		a.win = mygo.NewWindow(mygo.WindowOptions{
			Title:     "Agent Client GUI",
			Width:     820,
			Height:    720,
			MinWidth:  680,
			MinHeight: 560,
			StateKey:  "main",
			Content:   ui.View(a.view),
		})
		a.win.OnClosed(a.stopAll)
		go a.discoverAgent()
		a.refreshServers()
	})
	mygo.App.OnQuit(a.stopAll)

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
