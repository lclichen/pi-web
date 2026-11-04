package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

// The view builds without a window: a frame with a saved server shows the
// header, the server row, its disconnected state and the bundled CLI version.
func TestViewRendersSavedServers(t *testing.T) {
	a := newApp()
	a.agentVersion = "0.4.2"
	a.servers = []serverEntry{{
		Path:    "/home/me/.agent-client/config.json",
		Server:  "http://10.99.9.7:30142",
		Label:   "LapTop",
		Default: true,
	}}

	tt := ui.NewTester(a.view, 820, 720)
	for _, want := range []string{"Agent Client GUI", "agent-client 0.4.2", "LapTop", "http://10.99.9.7:30142", "未连接"} {
		if !tt.HasText(want) {
			t.Fatalf("view is missing %q; texts: %q", want, tt.Texts())
		}
	}
}

func TestViewRendersEmptyState(t *testing.T) {
	a := newApp()
	tt := ui.NewTester(a.view, 820, 720)
	if !tt.HasText("尚未配对任何服务器") {
		t.Fatalf("empty state missing; texts: %q", tt.Texts())
	}
}
