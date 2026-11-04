package main

import (
	"regexp"
	"strings"
)

var (
	// Both `--server URL` and `--server=URL` forms, with optional quotes.
	pairingServerRe = regexp.MustCompile(`(?i)--server(?:=|\s+)["']?([^\s"']+)`)
	pairingCodeRe   = regexp.MustCompile(`(?i)--code(?:=|\s+)["']?([^\s"']+)`)
	bareCodeRe      = regexp.MustCompile(`^[A-Za-z0-9_-]{4,64}$`)
	// A URL in prose ends at whitespace or CJK punctuation, which has no
	// spaces around it in Chinese sentences.
	urlRe = regexp.MustCompile(`https?://[^\s"'<>，。；、）】]+`)
)

// ParsePairingText extracts the relay address and pairing code from what the
// user pastes. Accepted shapes:
//
//	./agent-client pair --code 3JFSG6 --server http://10.99.9.7:30142
//	agent-client pair --server=http://host:30142 --code=ABC123
//	http://10.99.9.7:30142          (address only)
//	3JFSG6                          (code only)
//
// Empty results mean "not found" and must not overwrite fields the user typed.
func ParsePairingText(text string) (server, code string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", ""
	}
	if m := pairingServerRe.FindStringSubmatch(text); len(m) == 2 {
		server = strings.Trim(m[1], `"'`)
	}
	if m := pairingCodeRe.FindStringSubmatch(text); len(m) == 2 {
		code = strings.Trim(m[1], `"'`)
	}
	// A bare code (the WebUI shows it in its own cell) fills just the code.
	if server == "" && code == "" {
		if fields := strings.Fields(text); len(fields) == 1 && !strings.Contains(fields[0], "://") && bareCodeRe.MatchString(fields[0]) {
			code = fields[0]
		}
	}
	// A plain URL in prose still fills the address.
	if server == "" {
		if m := urlRe.FindString(text); m != "" {
			server = m
		}
	}
	return server, code
}
