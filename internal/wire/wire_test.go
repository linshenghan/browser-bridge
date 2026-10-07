package wire

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestChunkedRoundTrip(t *testing.T) {
	for _, size := range []int{1, ChunkSize - 100, ChunkSize, 3 * 1024 * 1024} {
		var b bytes.Buffer
		m := Message{Kind: "response", ID: "large", Session: "s", Result: Raw(map[string]string{"body": strings.Repeat("中", size/3)})}
		if e := (&Writer{W: &b}).Write(m); e != nil {
			t.Fatal(e)
		}
		got, e := (&Reader{R: &b}).Read()
		if e != nil {
			t.Fatal(e)
		}
		if !bytes.Equal(m.Result, got.Result) || got.ID != m.ID {
			t.Fatal("message changed")
		}
	}
}
func rawFrame(m Message) []byte {
	b, _ := json.Marshal(m)
	out := make([]byte, 4+len(b))
	binary.LittleEndian.PutUint32(out, uint32(len(b)))
	copy(out[4:], b)
	return out
}
func TestProtocolMismatch(t *testing.T) {
	_, e := (&Reader{R: bytes.NewReader(rawFrame(Message{Version: 99, Kind: "request"}))}).Read()
	if e == nil || !strings.Contains(e.Error(), "PROTOCOL_MISMATCH") {
		t.Fatal(e)
	}
}
func TestInvalidFrameAndChunk(t *testing.T) {
	cases := [][]byte{{0, 0, 0, 0}, {255, 255, 255, 255}, rawFrame(Message{Version: 1, Kind: "chunk", ID: "x", Index: 1, Total: 3, Data: "YQ=="}), append(rawFrame(Message{Version: 1, Kind: "chunk", ID: "x", Index: 0, Total: 2, Data: "YQ=="}), rawFrame(Message{Version: 1, Kind: "chunk", ID: "y", Index: 1, Total: 2, Data: "YQ=="})...)}
	for _, b := range cases {
		if _, e := (&Reader{R: bytes.NewReader(b)}).Read(); e == nil {
			t.Fatal("accepted invalid frame")
		}
	}
}
func TestDisconnectMidMessage(t *testing.T) {
	b := rawFrame(Message{Version: 1, Kind: "request", ID: "x"})
	_, e := (&Reader{R: bytes.NewReader(b[:len(b)-2])}).Read()
	if e != io.ErrUnexpectedEOF {
		t.Fatal(e)
	}
}

type shortWriter struct{ bytes.Buffer }

func (w *shortWriter) Write(p []byte) (int, error) {
	if len(p) > 7 {
		p = p[:7]
	}
	return w.Buffer.Write(p)
}
func TestPartialWrites(t *testing.T) {
	w := &shortWriter{}
	if e := (&Writer{W: w}).Write(Message{Kind: "response", ID: "partial", Result: Raw(map[string]bool{"ok": true})}); e != nil {
		t.Fatal(e)
	}
	if _, e := (&Reader{R: &w.Buffer}).Read(); e != nil {
		t.Fatal(e)
	}
}
