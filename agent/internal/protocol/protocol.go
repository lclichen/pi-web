// Package protocol defines the JSON wire shapes exchanged with the pi-web relay.
// Keep these in sync with pi-web/lib/relay/protocol.ts.
package protocol

// Request is a JSON-RPC call forwarded from the relay.
type Request struct {
	ID     int                    `json:"id"`
	Method string                 `json:"method"`
	Params map[string]interface{} `json:"params,omitempty"`
}

// Response is the final one-shot reply for a Request id.
type Response struct {
	ID     int         `json:"id"`
	OK     bool        `json:"ok"`
	Result interface{} `json:"result,omitempty"`
	Error  string      `json:"error,omitempty"`
}

// Hello is the first frame the agent sends after the WebSocket opens, carrying
// static metadata about the connected machine.
type Hello struct {
	Type string    `json:"type"` // always "hello"
	Info AgentInfo `json:"info"`
}

// AgentInfo describes the connected machine + its workspace root.
type AgentInfo struct {
	Hostname      string `json:"hostname"`
	OS            string `json:"os"`
	Arch          string `json:"arch"`
	WorkspaceRoot string `json:"workspaceRoot"`
	AgentVersion  string `json:"agentVersion"`
}

// FsEntry is one row in an fs.list result.
type FsEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}
