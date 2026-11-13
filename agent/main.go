// Command agent-client connects this machine to a pi-web workspace. It runs
// on the user's machine (e.g. CentOS 7), connects out to the pi-web relay over
// WebSocket, and serves file + command requests scoped to a workspace root.
//
// Usage:
//
//	agent-client pair --code CODE --server URL [--root PATH] [--label NAME]
//	agent-client run  [--server URL] [--root PATH] [--interactive] [--list]
//	agent-client version
package main

import (
	"fmt"
	"os"

	"piagent/internal/agent"
)

const version = "0.6.0"

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
	// Default subcommand: run. On a terminal it opens the interactive menu;
	// under systemd (no TTY) it connects to the saved/current connection.
	os.Exit(agent.Run(args, version))
}

func printUsage() {
	fmt.Println(`agent-client — connect this machine to pi-web

Usage:
  ./agent-client pair --code CODE --server URL [--root PATH] [--label NAME] [--force]
  ./agent-client run [--config FILE] [--server URL] [--root PATH]
                     [--replace] [--interactive] [--list]
  ./agent-client version | --version | -V
  ./agent-client help

Run without --server on a terminal to choose from saved connections and
control them (connect / switch / new connection / disconnect / re-pair). In a
service or a script (no TTY) it connects to --server, else the last used /
only one.

Workspace root: --root / the directory run is started in / the saved root
(service cwd "/" or home) / home. Starting the client in a project directory
switches it there; pass --root in systemd units.

Config: ONE file, ~/.agent-client/config.json (mode 0600), holding every
connection in a map keyed by relay URL. Legacy single configs,
~/.agent-client/profiles/*.json and ~/.pi-agent/config.json are migrated
automatically. If a token expires or is revoked, re-run pair (the interactive
menu's "r"); no need to delete the client. A running client refuses a second
client for the same machine unless it is started with --replace.`)
}
