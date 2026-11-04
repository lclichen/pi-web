// Command agent-client connects this machine to a pi-web workspace. It runs
// on the user's machine (e.g. CentOS 7), connects out to the pi-web relay over
// WebSocket, and serves file + command requests scoped to a workspace root.
//
// Usage:
//
//	agent-client pair --code CODE --server URL [--root PATH]
//	agent-client run   [--config FILE] [--server URL] [--root PATH]
//	agent-client version
package main

import (
	"fmt"
	"os"

	"piagent/internal/agent"
)

const version = "0.4.2"

func main() {
	args := os.Args[1:]
	if len(args) > 0 {
		switch args[0] {
		case "pair":
			os.Exit(agent.RunPair(args[1:], version))
		case "run":
			os.Exit(agent.Run(args[1:], version))
		case "version", "--version", "-v", "-V":
			fmt.Println("agent-client", version)
			return
		case "help", "--help", "-h":
			printUsage()
			return
		}
	}
	// Default subcommand: run (the persistent service loop).
	os.Exit(agent.Run(args, version))
}

func printUsage() {
	fmt.Println(`agent-client — connect this machine to pi-web

Usage:
  agent-client pair --code CODE --server URL [--root PATH] [--label NAME]   pair with a pi-web relay
  agent-client run [--config FILE] [--server URL] [--root PATH]            connect & serve (default)
  agent-client version | --version | -V
  agent-client help

Workspace root: --root / the directory run is started in / the saved root
(service cwd "/" or home) / home. Starting the client in a project directory
switches it there; pass --root in systemd units.

Config: ~/.agent-client/config.json (mode 0600). Pairing a DIFFERENT server
stores that pairing in ~/.agent-client/profiles/<server>.json instead of
overwriting the first one; run it with --server <URL>.
An existing ~/.pi-agent/config.json is used as a fallback.`)
}
