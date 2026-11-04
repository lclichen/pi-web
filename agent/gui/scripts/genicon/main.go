// Command genicon draws the app icon: a neutral monitor with a "connected"
// check, not pi's logo. Committed so the icon is reproducible:
//
//	go run ./scripts/genicon resources/icon.png
package main

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
)

const size = 1024 // drawn large, then box-downsampled to 512

func main() {
	out := "resources/icon.png"
	if len(os.Args) > 1 {
		out = os.Args[1]
	}
	img := image.NewRGBA(image.Rect(0, 0, size, size))

	bg := color.RGBA{0x1d, 0x4e, 0xd8, 0xff}     // blue
	white := color.RGBA{0xff, 0xff, 0xff, 0xff}  // monitor body
	screen := color.RGBA{0x0f, 0x17, 0x2a, 0xff} // screen
	green := color.RGBA{0x22, 0xc5, 0x5e, 0xff}  // connected

	fillCircle(img, 512, 512, 480, bg)
	fillRoundedRect(img, 232, 300, 560, 360, 32, white)
	fillRoundedRect(img, 264, 332, 496, 296, 20, screen)
	fillRoundedRect(img, 472, 660, 80, 64, 8, white)
	fillRoundedRect(img, 352, 724, 320, 36, 18, white)

	fillCircle(img, 752, 620, 58, green)
	drawThickLine(img, 724, 620, 744, 642, 14, white)
	drawThickLine(img, 744, 642, 782, 596, 14, white)

	scaled := downsample(img, 2)
	f, err := os.Create(out)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer f.Close()
	if err := png.Encode(f, scaled); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func fillCircle(img *image.RGBA, cx, cy, r int, c color.RGBA) {
	for y := cy - r; y <= cy+r; y++ {
		for x := cx - r; x <= cx+r; x++ {
			dx, dy := x-cx, y-cy
			if dx*dx+dy*dy <= r*r {
				img.SetRGBA(x, y, c)
			}
		}
	}
}

func fillRoundedRect(img *image.RGBA, x0, y0, w, h, r int, c color.RGBA) {
	for y := y0; y < y0+h; y++ {
		for x := x0; x < x0+w; x++ {
			// Distance to the nearest corner circle centre.
			cx := x
			if cx < x0+r {
				cx = x0 + r
			} else if cx > x0+w-1-r {
				cx = x0 + w - 1 - r
			}
			cy := y
			if cy < y0+r {
				cy = y0 + r
			} else if cy > y0+h-1-r {
				cy = y0 + h - 1 - r
			}
			dx, dy := x-cx, y-cy
			if dx*dx+dy*dy <= r*r {
				img.SetRGBA(x, y, c)
			}
		}
	}
}

func drawThickLine(img *image.RGBA, x0, y0, x1, y1, width int, c color.RGBA) {
	steps := 400
	for i := 0; i <= steps; i++ {
		t := float64(i) / float64(steps)
		x := float64(x0) + (float64(x1)-float64(x0))*t
		y := float64(y0) + (float64(y1)-float64(y0))*t
		fillCircle(img, int(x), int(y), width/2, c)
	}
}

// downsample averages factor×factor blocks (factor 2 halves the image).
func downsample(src *image.RGBA, factor int) *image.RGBA {
	w := src.Bounds().Dx() / factor
	h := src.Bounds().Dy() / factor
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var r, g, b, a uint32
			for dy := 0; dy < factor; dy++ {
				for dx := 0; dx < factor; dx++ {
					c := src.RGBAAt(x*factor+dx, y*factor+dy)
					r += uint32(c.R) * uint32(c.A) / 255
					g += uint32(c.G) * uint32(c.A) / 255
					b += uint32(c.B) * uint32(c.A) / 255
					a += uint32(c.A)
				}
			}
			n := uint32(factor * factor)
			if a == 0 {
				continue
			}
			dst.SetRGBA(x, y, color.RGBA{
				R: uint8(r / n),
				G: uint8(g / n),
				B: uint8(b / n),
				A: uint8(a / n),
			})
		}
	}
	return dst
}
