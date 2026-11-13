//go:build windows

package agent

import (
	"os"
	"syscall"
	"unsafe"
)

var (
	kernel32                       = syscall.NewLazyDLL("kernel32.dll")
	procGetConsoleScreenBufferInfo = kernel32.NewProc("GetConsoleScreenBufferInfo")
	procGetConsoleMode             = kernel32.NewProc("GetConsoleMode")
	procSetConsoleMode             = kernel32.NewProc("SetConsoleMode")
)

type consoleCoord struct {
	X int16
	Y int16
}

type consoleRect struct {
	Left   int16
	Top    int16
	Right  int16
	Bottom int16
}

type consoleScreenBufferInfo struct {
	Size              consoleCoord
	CursorPosition    consoleCoord
	Attributes        uint16
	Window            consoleRect
	MaximumWindowSize consoleCoord
}

func terminalSize(f *os.File) (width, height int, ok bool) {
	var info consoleScreenBufferInfo
	r, _, _ := procGetConsoleScreenBufferInfo.Call(f.Fd(), uintptr(unsafe.Pointer(&info)))
	if r == 0 {
		return 0, 0, false
	}
	w := int(info.Window.Right-info.Window.Left) + 1
	h := int(info.Window.Bottom-info.Window.Top) + 1
	if w <= 0 || h <= 0 {
		return 0, 0, false
	}
	return w, h, true
}

// ansiSupported turns on VT100 escape processing for the console. Legacy
// conhost rejects it, in which case the caller keeps the plain line UI.
func ansiSupported() bool {
	h, err := syscall.GetStdHandle(syscall.STD_OUTPUT_HANDLE)
	if err != nil {
		return false
	}
	var mode uint32
	if r, _, _ := procGetConsoleMode.Call(uintptr(h), uintptr(unsafe.Pointer(&mode))); r == 0 {
		return false
	}
	const (
		enableProcessedOutput           = 0x0001
		enableVirtualTerminalProcessing = 0x0004
	)
	if mode&enableVirtualTerminalProcessing == 0 {
		want := mode | enableProcessedOutput | enableVirtualTerminalProcessing
		if r, _, _ := procSetConsoleMode.Call(uintptr(h), uintptr(want)); r == 0 {
			return false
		}
	}
	return true
}
