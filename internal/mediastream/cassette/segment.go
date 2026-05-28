package cassette

import (
	"context"
	"fmt"
	"sync"
)

// SegmentTable tracks which segments are ready
type SegmentTable struct {
	mu       sync.RWMutex
	segments []segmentEntry
}

type segmentEntry struct {
	// ch is closed when the segment is ready on disk.
	ch chan struct{}
	// encoderID is the head that produced the segment.
	encoderID int
}

// NewSegmentTable creates a table with initialLen segments
func NewSegmentTable(initialLen int32) *SegmentTable {
	st := &SegmentTable{
		segments: make([]segmentEntry, initialLen, max(initialLen, 2048)),
	}
	for i := range st.segments {
		st.segments[i].ch = make(chan struct{})
	}
	return st
}

// Grow extends the table to at least newLen segments
func (st *SegmentTable) Grow(newLen int) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if newLen <= len(st.segments) {
		return
	}
	for i := len(st.segments); i < newLen; i++ {
		st.segments = append(st.segments, segmentEntry{ch: make(chan struct{})})
	}
}

// Len returns the current number of tracked segments
func (st *SegmentTable) Len() int {
	st.mu.RLock()
	defer st.mu.RUnlock()
	return len(st.segments)
}

// IsReady returns true if segment is ready. Out-of-bounds seg returns false
// rather than panicking; callers can interpret that as "not ready, please
// schedule encoding" which is the correct semantic.
func (st *SegmentTable) IsReady(seg int32) bool {
	st.mu.RLock()
	defer st.mu.RUnlock()
	if seg < 0 || int(seg) >= len(st.segments) {
		return false
	}
	select {
	case <-st.segments[seg].ch:
		return true
	default:
		return false
	}
}

// isReadyLocked is like IsReady but expects at least an RLock to be held.
func (st *SegmentTable) isReadyLocked(seg int32) bool {
	if seg < 0 || int(seg) >= len(st.segments) {
		return false
	}
	select {
	case <-st.segments[seg].ch:
		return true
	default:
		return false
	}
}

// MarkReady marks a segment as ready. Out-of-bounds seg is a no-op so a
// stale ffmpeg head writing a segment past the current table size can't
// crash the server.
func (st *SegmentTable) MarkReady(seg int32, encoderID int) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if seg < 0 || int(seg) >= len(st.segments) {
		return
	}
	select {
	case <-st.segments[seg].ch:
		// Already closed; idempotent.
	default:
		st.segments[seg].encoderID = encoderID
		close(st.segments[seg].ch)
	}
}

// EncoderID returns the encoder that produced the given segment, or 0 for
// out-of-bounds indices.
func (st *SegmentTable) EncoderID(seg int32) int {
	st.mu.RLock()
	defer st.mu.RUnlock()
	if seg < 0 || int(seg) >= len(st.segments) {
		return 0
	}
	return st.segments[seg].encoderID
}

// WaitFor blocks until segment is ready or context is cancelled. Out-of-bounds
// seg returns an error immediately rather than panicking.
func (st *SegmentTable) WaitFor(ctx context.Context, seg int32, kill <-chan struct{}) error {
	st.mu.RLock()
	if seg < 0 || int(seg) >= len(st.segments) {
		st.mu.RUnlock()
		return fmt.Errorf("segment %d out of range (table size %d)", seg, len(st.segments))
	}
	ch := st.segments[seg].ch
	st.mu.RUnlock()

	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-kill:
		return context.Canceled
	}
}
