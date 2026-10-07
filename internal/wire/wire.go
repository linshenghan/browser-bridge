// Package wire implements the bounded, chunked protocol used on both local transports.
package wire

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

const Version = 1
const MaxFrame = 512 * 1024
const MaxMessage = 24 * 1024 * 1024
const ChunkSize = 192 * 1024

type Error struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Uncertain bool   `json:"uncertain,omitempty"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

type Message struct {
	Version  int             `json:"version"`
	Kind     string          `json:"kind"`
	ID       string          `json:"requestId,omitempty"`
	Session  string          `json:"sessionId,omitempty"`
	Client   string          `json:"clientId,omitempty"`
	Profile  string          `json:"profileId,omitempty"`
	Deadline int64           `json:"deadline,omitempty"`
	Method   string          `json:"method,omitempty"`
	Params   json.RawMessage `json:"params,omitempty"`
	Result   json.RawMessage `json:"result,omitempty"`
	Error    *Error          `json:"error,omitempty"`
	Index    int             `json:"index,omitempty"`
	Total    int             `json:"total,omitempty"`
	Data     string          `json:"data,omitempty"`
}

func Raw(v any) json.RawMessage { b, _ := json.Marshal(v); return b }

type Writer struct {
	W  io.Writer
	mu sync.Mutex
}

func (w *Writer) Write(m Message) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	m.Version = Version
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if len(b) > MaxMessage {
		return errors.New("MESSAGE_TOO_LARGE")
	}
	if len(b) <= ChunkSize {
		return w.frame(b)
	}
	total := (len(b) + ChunkSize - 1) / ChunkSize
	for i := 0; i < total; i++ {
		end := (i + 1) * ChunkSize
		if end > len(b) {
			end = len(b)
		}
		part, _ := json.Marshal(Message{Version: Version, Kind: "chunk", ID: m.ID, Index: i, Total: total, Data: base64.StdEncoding.EncodeToString(b[i*ChunkSize : end])})
		if err = w.frame(part); err != nil {
			return err
		}
	}
	return nil
}
func (w *Writer) frame(b []byte) error {
	var hdr [4]byte
	binary.LittleEndian.PutUint32(hdr[:], uint32(len(b)))
	if err := writeAll(w.W, hdr[:]); err != nil {
		return err
	}
	return writeAll(w.W, b)
}
func writeAll(w io.Writer, b []byte) error {
	for len(b) > 0 {
		n, e := w.Write(b)
		if e != nil {
			return e
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		b = b[n:]
	}
	return nil
}

type Reader struct{ R io.Reader }

func (r *Reader) Read() (Message, error) {
	m, err := r.frame()
	if err != nil {
		return m, err
	}
	if m.Kind != "chunk" {
		return m, nil
	}
	if m.ID == "" || m.Index != 0 || m.Total < 1 || m.Total > (MaxMessage/ChunkSize+1) {
		return m, errors.New("INVALID_CHUNK")
	}
	id, total := m.ID, m.Total
	buf := make([]byte, 0)
	start := time.Now()
	for i := 0; i < total; i++ {
		if i > 0 {
			m, err = r.frame()
			if err != nil {
				return m, err
			}
		}
		if m.Kind != "chunk" || m.ID != id || m.Index != i || m.Total != total || time.Since(start) > 30*time.Second {
			return m, errors.New("INVALID_CHUNK_ORDER")
		}
		part, e := base64.StdEncoding.DecodeString(m.Data)
		if e != nil {
			return m, e
		}
		buf = append(buf, part...)
		if len(buf) > MaxMessage {
			return m, errors.New("MESSAGE_TOO_LARGE")
		}
	}
	if err = json.Unmarshal(buf, &m); err != nil {
		return m, err
	}
	if m.Kind == "chunk" {
		return m, errors.New("NESTED_CHUNK")
	}
	if m.Version != Version {
		return m, fmt.Errorf("PROTOCOL_MISMATCH: expected %d, got %d; 请同时升级扩展和服务", Version, m.Version)
	}
	return m, nil
}
func (r *Reader) frame() (Message, error) {
	var m Message
	var hdr [4]byte
	if _, err := io.ReadFull(r.R, hdr[:]); err != nil {
		return m, err
	}
	n := binary.LittleEndian.Uint32(hdr[:])
	if n == 0 || n > MaxFrame {
		return m, errors.New("INVALID_FRAME_SIZE")
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(r.R, b); err != nil {
		return m, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return m, err
	}
	if m.Version != Version {
		return m, fmt.Errorf("PROTOCOL_MISMATCH: expected %d, got %d; 请同时升级扩展和服务", Version, m.Version)
	}
	return m, nil
}
