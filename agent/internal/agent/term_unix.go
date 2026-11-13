//go:build linux || darwin

package agent

import (
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

// TIOCGWINSZ differs between Linux and Darwin. Both return a winsize struct.
func ioctlGetWinsize() uintptr {
	if runtime.GOOS == "darwin" {
		return 0x40087468
	}
	return 0x5413 // linux
}

// terminalSize reports the terminal window size for f, or ok=false when f is
// not a terminal / the ioctl fails (then the caller falls back to 80x24).
func terminalSize(f *os.File) (width, height int, ok bool) {
	type winsize struct {
		Row    uint16
		Col    uint16
		Xpixel uint16
		Ypixel uint16
	}
	var ws winsize
	_, _, errno := syscall.Syscall(
		syscall.SYS_IOCTL,
		f.Fd(),
		ioctlGetWinsize(),
		uintptr(unsafe.Pointer(&ws)),
	)
	if errno != 0 || ws.Col == 0 || ws.Row == 0 {
		return 0, 0, false
	}
	return int(ws.Col), int(ws.Row), true
}

// ansiSupported rejects dumb terminals; every real Linux/macOS terminal
// understands the cursor-addressing sequences the dashboard uses.
func ansiSupported() bool {
	term := os.Getenv("TERM")
	return term != "" && term != "dumb"
}
