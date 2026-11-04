// Command fixmodes repairs the executable bits of MyGo's Linux packages when
// they are built on Windows: archive entries created there are 0666/0644, so
// both the GUI executable and the bundled agent-client would arrive without
// +x. It rewrites the .tar.gz data archive inside .deb files as well, keeping
// every other byte of the package.
//
// Usage: go run ./scripts/fixmodes <file.tar.gz|file.deb>...
package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path"
	"strconv"
)

var executableNames = map[string]bool{
	"agent-client-gui": true,
	"agent-client":     true,
	"install.sh":       true,
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: fixmodes <file.tar.gz|file.deb>...")
		os.Exit(2)
	}
	for _, name := range os.Args[1:] {
		var err error
		switch path.Ext(name) {
		case ".gz":
			err = fixTarGzFile(name)
		case ".deb":
			err = fixDeb(name)
		default:
			err = fmt.Errorf("unsupported file %s", name)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "fixmodes: %s: %v\n", name, err)
			os.Exit(1)
		}
		fmt.Println("fixed", name)
	}
}

func modeFor(header *tar.Header) int64 {
	base := path.Base(header.Name)
	if header.Typeflag == tar.TypeDir {
		return 0o755
	}
	if executableNames[base] {
		return 0o755
	}
	if header.Mode == 0 {
		return 0o644
	}
	return header.Mode
}

// rewriteTarGz returns the same archive with executable bits fixed.
func rewriteTarGz(data []byte) ([]byte, error) {
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(reader)
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		header.Mode = modeFor(header)
		if err := tw.WriteHeader(header); err != nil {
			return nil, err
		}
		if header.Typeflag == tar.TypeReg || header.Typeflag == tar.TypeRegA {
			if _, err := io.Copy(tw, tr); err != nil {
				return nil, err
			}
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func fixTarGzFile(name string) error {
	data, err := os.ReadFile(name)
	if err != nil {
		return err
	}
	fixed, err := rewriteTarGz(data)
	if err != nil {
		return err
	}
	return os.WriteFile(name, fixed, 0o644)
}

type arMember struct {
	header []byte // 60 bytes, size field updated on write
	data   []byte
}

const arMagic = "!<arch>\n"

func fixDeb(name string) error {
	raw, err := os.ReadFile(name)
	if err != nil {
		return err
	}
	if len(raw) < len(arMagic) || string(raw[:len(arMagic)]) != arMagic {
		return fmt.Errorf("not an ar archive")
	}
	members := make([]arMember, 0, 3)
	rest := raw[len(arMagic):]
	for len(rest) > 0 {
		if len(rest) < 60 {
			return fmt.Errorf("truncated ar header")
		}
		header := append([]byte(nil), rest[:60]...)
		rest = rest[60:]
		size, err := strconv.Atoi(string(bytes.TrimSpace(header[48:58])))
		if err != nil || size < 0 || size > len(rest) {
			return fmt.Errorf("bad ar member size")
		}
		data := append([]byte(nil), rest[:size]...)
		rest = rest[size:]
		if size%2 == 1 && len(rest) > 0 {
			rest = rest[1:] // member padding
		}
		if string(bytes.TrimRight(header[:16], " ")) == "data.tar.gz" {
			if data, err = rewriteTarGz(data); err != nil {
				return err
			}
		}
		members = append(members, arMember{header: header, data: data})
	}

	var out bytes.Buffer
	out.WriteString(arMagic)
	for _, member := range members {
		header := append([]byte(nil), member.header...)
		copy(header[48:58], []byte(fmt.Sprintf("%-10d", len(member.data))))
		out.Write(header)
		out.Write(member.data)
		if len(member.data)%2 == 1 {
			out.WriteByte('\n')
		}
	}
	return os.WriteFile(name, out.Bytes(), 0o644)
}
