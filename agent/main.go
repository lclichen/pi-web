// Command pi-agent is the local-machine bridge for pi-web's "Connect Local
// Machine" feature. It runs on the user's machine (e.g. CentOS 7), connects out
// to the pi-web relay over WebSocket, and serves file + command requests scoped
// to a workspace root.
//
// Usage:
//
//	pi-agent pair --code CODE --server URL [--root PATH]
//	pi-agent run   [--config FILE] [--root PATH]
//	pi-agent version
package main

import (
	"fmt"
	"os"

	"piagent/internal/agent"
)

const version = "0.1.2"

func main() {
	args := os.Args[1:]
	if len(args) > 0 {
		switch args[0] {
		case "pair":
			os.Exit(agent.RunPair(args[1:], version))
		case "run":
			os.Exit(agent.Run(args[1:], version))
		case "version", "--version", "-v":
			fmt.Println("pi-agent", version)
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
	fmt.Println(`pi-agent — local machine bridge for pi-web

Usage:
  pi-agent pair --code CODE --server URL [--root PATH]   pair with a pi-web relay
  pi-agent run [--config FILE] [--root PATH]             connect & serve (default)
  pi-agent version
  pi-agent help

Config is stored at ~/.pi-agent/config.json (mode 0600).`)
}
