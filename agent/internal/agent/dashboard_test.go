package agent

import (
	"fmt"
	"strings"
	"testing"

	"piagent/internal/config"
)

func TestDisplayWidthCountsWideRunes(t *testing.T) {
	cases := map[string]int{
		"abc":   3,
		"实验室":   6,
		"a实验室b": 8,
		"":      0,
	}
	for text, want := range cases {
		if got := displayWidth(text); got != want {
			t.Fatalf("displayWidth(%q) = %d, want %d", text, got, want)
		}
	}
}

func TestTruncateDisplayNeverExceedsWidth(t *testing.T) {
	if got := truncateDisplay("short", 10); got != "short" {
		t.Fatalf("short line changed: %q", got)
	}
	for _, tc := range []struct {
		text string
		max  int
	}{
		{"hello world", 8},
		{"实验室服务器", 7},
		{"http://10.99.9.7:30142 实验室服务器 已连接", 24},
	} {
		got := truncateDisplay(tc.text, tc.max)
		if width := displayWidth(got); width > tc.max {
			t.Fatalf("truncateDisplay(%q, %d) = %q (%d cols)", tc.text, tc.max, got, width)
		}
		if !strings.HasSuffix(got, "…") {
			t.Fatalf("truncateDisplay(%q, %d) = %q, want an ellipsis", tc.text, tc.max, got)
		}
	}
}

func TestStatusLinesFitAndSummarizeOverflow(t *testing.T) {
	d := &dashboard{height: 16, width: 80}
	for i := 0; i < 20; i++ {
		d.entries = append(d.entries, &config.ServerConfig{
			Server: fmt.Sprintf("http://server-%02d:30142", i),
			Label:  "机器",
		})
	}
	lines := d.statusLinesLocked()
	if len(lines) > d.height-5 {
		t.Fatalf("status block too tall: %d lines for height %d", len(lines), d.height)
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "另有") {
		t.Fatalf("overflow summary missing:\n%s", joined)
	}
	if !strings.Contains(joined, "q=退出") {
		t.Fatalf("options line missing:\n%s", joined)
	}
}

func TestStatusLinesEmptyState(t *testing.T) {
	d := &dashboard{height: 24, width: 80}
	lines := d.statusLinesLocked()
	if len(lines) != 3 { // header + hint + options
		t.Fatalf("empty status = %#v", lines)
	}
	if !strings.Contains(strings.Join(lines, "\n"), "按 n 新建连接") {
		t.Fatalf("empty hint missing: %#v", lines)
	}
}
