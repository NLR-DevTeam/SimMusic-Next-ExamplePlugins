// Command musicSyncUpload is run by the "一起听" extension to stream a song's file to the relay:
//
//	musicSyncUpload size <path>                 prints the number of bytes that will be sent
//	musicSyncUpload <address> <path> [resume]   sends them; with resume, what the relay does not have yet of an
//	                                            upload that was stopped
//
// What is sent is the audio alone: an MP3's leading ID3v2 tag and a FLAC's pictures and padding are left out.
// They come before the first frame, often hundreds of kilobytes of cover art, and a listener could not start
// until they had arrived; the cover reaches the listeners by its own way. The last 128 KiB go first, on their
// own: a browser reads the end of a file (its tags) before it plays. The share's password, if it has one,
// comes in the MUSICSYNC_PASSWORD environment variable. The extension cannot send a file of any size itself;
// this sends it as it is read, so that the members listening can start while the rest is still on its way.
// The exit code is 0 once the relay has it all.
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
)

// audioPart is what is sent of the file: head (rebuilt metadata, may be empty), then the file from offset on.
func audioPart(f *os.File, size int64) (head []byte, offset int64) {
	var start [10]byte
	if n, _ := f.ReadAt(start[:], 0); n < 10 {
		return nil, 0
	}
	switch {
	case string(start[:3]) == "ID3":
		length := int64(start[6]&0x7f)<<21 | int64(start[7]&0x7f)<<14 | int64(start[8]&0x7f)<<7 | int64(start[9]&0x7f)
		end := 10 + length
		if start[5]&0x10 != 0 {
			end += 10 // footer
		}
		if end < size {
			return nil, end
		}
	case string(start[:4]) == "fLaC":
		// Metadata blocks: 1 bit "last", 7 bits type, 24 bits length. Kept: all but PADDING (1) and PICTURE (6).
		head = []byte("fLaC")
		at, lastKept := int64(4), -1
		for at+4 <= size {
			var h [4]byte
			if _, err := f.ReadAt(h[:], at); err != nil {
				return nil, 0
			}
			last, kind := h[0]&0x80 != 0, h[0]&0x7f
			length := int64(binary.BigEndian.Uint32([]byte{0, h[1], h[2], h[3]}))
			if at+4+length > size {
				return nil, 0
			}
			if kind != 1 && kind != 6 {
				block := make([]byte, 4+length)
				if _, err := f.ReadAt(block, at); err != nil {
					return nil, 0
				}
				block[0] &^= 0x80
				lastKept = len(head)
				head = append(head, block...)
			}
			at += 4 + length
			if last {
				if lastKept < 0 {
					return nil, 0
				}
				head[lastKept] |= 0x80
				return head, at
			}
		}
		return nil, 0
	}
	return nil, 0
}

const tailSize = 128 << 10

// put sends body to address with the password of the share. A refusal that says how much the relay has
// (an upload to continue from elsewhere) comes back as that number.
func put(address string, body io.Reader, length int64) (int64, error) {
	req, err := http.NewRequest(http.MethodPut, address, body)
	if err != nil {
		return -1, err
	}
	req.ContentLength = length
	if password := os.Getenv("MUSICSYNC_PASSWORD"); password != "" {
		req.Header.Set("X-Sync-Password", password)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return -1, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusConflict {
		var state struct {
			Written int64 `json:"written"`
		}
		if json.NewDecoder(resp.Body).Decode(&state) == nil {
			return state.Written, fmt.Errorf("%s", resp.Status)
		}
	}
	if resp.StatusCode/100 != 2 {
		return -1, fmt.Errorf("%s", resp.Status)
	}
	return -1, nil
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: musicSyncUpload size <path> | musicSyncUpload <address> <path>")
		os.Exit(2)
	}
	in, err := os.Open(os.Args[2])
	if err != nil {
		fail(err)
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		fail(err)
	}
	head, offset := audioPart(in, info.Size())
	length := int64(len(head)) + info.Size() - offset
	if os.Args[1] == "size" {
		fmt.Println(strconv.FormatInt(length, 10))
		return
	}
	content := func(from int64) io.Reader {
		body := io.MultiReader(bytes.NewReader(head), io.NewSectionReader(in, offset, info.Size()-offset))
		io.CopyN(io.Discard, body, from)
		return body
	}
	resume := len(os.Args) > 3 && os.Args[3] == "resume"
	// The end of the file first; a relay that does not take it ahead only loses that head start.
	if tail := min(tailSize, info.Size()-offset); !resume && tail > 0 && length > tail {
		put(os.Args[1]+"?tail="+strconv.FormatInt(length-tail, 10), io.NewSectionReader(in, info.Size()-tail, tail), tail)
	}
	written, err := put(os.Args[1]+"?offset=0", content(0), length)
	if written > 0 && written < length {
		// Stopped before: the rest from where the relay has it.
		_, err = put(os.Args[1]+"?offset="+strconv.FormatInt(written, 10), content(written), length-written)
	}
	if err != nil {
		fail(err)
	}
}
