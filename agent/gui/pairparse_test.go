package main

import (
	"testing"
)

func TestParsePairingText(t *testing.T) {
	cases := []struct {
		name       string
		text       string
		wantServer string
		wantCode   string
	}{
		{
			name:       "full linux command",
			text:       "./agent-client pair --code 3JFSG6 --server http://10.99.9.7:30142",
			wantServer: "http://10.99.9.7:30142",
			wantCode:   "3JFSG6",
		},
		{
			name:       "full windows command, reversed flags",
			text:       `.\agent-client.exe pair --server http://10.0.0.5:30142 --code ABC123 --label 工位机`,
			wantServer: "http://10.0.0.5:30142",
			wantCode:   "ABC123",
		},
		{
			name:       "equals form and quotes",
			text:       `agent-client pair --server="http://host:30142" --code='XYZ789'`,
			wantServer: "http://host:30142",
			wantCode:   "XYZ789",
		},
		{
			name:       "bare code",
			text:       "3JFSG6",
			wantServer: "",
			wantCode:   "3JFSG6",
		},
		{
			name:       "bare url",
			text:       "  http://10.99.9.7:30142  ",
			wantServer: "http://10.99.9.7:30142",
			wantCode:   "",
		},
		{
			name:       "url inside prose",
			text:       "服务器是 http://10.99.9.7:30142，配对码稍后给。",
			wantServer: "http://10.99.9.7:30142",
			wantCode:   "",
		},
		{
			name:       "nothing useful",
			text:       "hello world",
			wantServer: "",
			wantCode:   "",
		},
		{
			name:       "empty",
			text:       "   ",
			wantServer: "",
			wantCode:   "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server, code := ParsePairingText(tc.text)
			if server != tc.wantServer || code != tc.wantCode {
				t.Fatalf("ParsePairingText(%q) = (%q, %q), want (%q, %q)", tc.text, server, code, tc.wantServer, tc.wantCode)
			}
		})
	}
}

func TestSavedConfigPath(t *testing.T) {
	out := "paired with http://host:30142 (machine abc)\ntoken saved to /home/me/.agent-client/profiles/http_host_30142.json\nnext: ./agent-client run --server http://host:30142\n"
	if got := savedConfigPath(out); got != "/home/me/.agent-client/profiles/http_host_30142.json" {
		t.Fatalf("savedConfigPath = %q", got)
	}
}
