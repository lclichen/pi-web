package agent

import "testing"

func TestParsePairInput(t *testing.T) {
	cases := []struct {
		line   string
		server string
		code   string
		label  string
	}{
		{"http://a:30142", "http://a:30142", "", ""},
		{"10.0.0.5:30142", "10.0.0.5:30142", "", ""},
		{"./agent-client pair --code ABC123 --server http://b:30142 --label lab", "http://b:30142", "ABC123", "lab"},
		{"agent-client pair --server https://relay.example:30142 --code XYZ789", "https://relay.example:30142", "XYZ789", ""},
		{"--server=http://c:30142 --code=XYZ789", "http://c:30142", "XYZ789", ""},
		{`pair --code "ABC123" --server "http://d:30142"`, "http://d:30142", "ABC123", ""},
		{"", "", "", ""},
	}
	for _, tc := range cases {
		server, code, label := parsePairInput(tc.line)
		if server != tc.server || code != tc.code || label != tc.label {
			t.Fatalf("parsePairInput(%q) = (%q, %q, %q), want (%q, %q, %q)",
				tc.line, server, code, label, tc.server, tc.code, tc.label)
		}
	}
}
