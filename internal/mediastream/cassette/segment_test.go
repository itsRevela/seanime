package cassette

import (
	"context"
	"testing"
	"time"
)

// Regression: before the bounds-check defense, IsReady(seg) with an
// out-of-range seg panicked with "index out of range" and took the whole
// process down. Reproduced on a KonoSuba file where the segment table was
// sized from a stale keyframe count while a fresh request asked for seg=228.
func TestSegmentTable_OutOfBoundsDoesNotPanic(t *testing.T) {
	t.Parallel()

	st := NewSegmentTable(100)

	// All the public read paths should report "not ready" / sentinel values
	// for out-of-range indices instead of panicking.
	if st.IsReady(228) {
		t.Error("IsReady(228) on a 100-entry table should return false")
	}
	if st.EncoderID(228) != 0 {
		t.Error("EncoderID(228) out of bounds should return 0")
	}

	// MarkReady on an out-of-range seg should be a no-op, not a panic.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("MarkReady out of bounds should not panic: %v", r)
		}
	}()
	st.MarkReady(228, 0)
	st.MarkReady(-1, 0)
}

func TestSegmentTable_WaitForOutOfBoundsReturnsError(t *testing.T) {
	t.Parallel()

	st := NewSegmentTable(100)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	kill := make(chan struct{})
	err := st.WaitFor(ctx, 228, kill)
	if err == nil {
		t.Fatal("WaitFor(228) on a 100-entry table should return an error")
	}
}

func TestSegmentTable_HappyPath(t *testing.T) {
	t.Parallel()

	st := NewSegmentTable(10)

	if st.IsReady(3) {
		t.Error("freshly created segment should not be ready")
	}

	st.MarkReady(3, 7)
	if !st.IsReady(3) {
		t.Error("expected segment 3 to be ready after MarkReady")
	}
	if got := st.EncoderID(3); got != 7 {
		t.Errorf("EncoderID(3) = %d, want 7", got)
	}

	// MarkReady is idempotent: calling it again must not double-close the channel.
	st.MarkReady(3, 99)
	if got := st.EncoderID(3); got != 7 {
		t.Errorf("second MarkReady should be idempotent, EncoderID(3) = %d, want 7", got)
	}
}

func TestSegmentTable_Grow(t *testing.T) {
	t.Parallel()

	st := NewSegmentTable(10)
	if got := st.Len(); got != 10 {
		t.Fatalf("initial Len = %d, want 10", got)
	}

	st.Grow(50)
	if got := st.Len(); got != 50 {
		t.Fatalf("after Grow(50) Len = %d, want 50", got)
	}

	// Shrinking via Grow is a no-op.
	st.Grow(5)
	if got := st.Len(); got != 50 {
		t.Errorf("Grow with smaller value should not shrink: Len = %d, want 50", got)
	}

	// After growing, previously-out-of-bounds indices are now valid.
	if st.IsReady(40) {
		t.Error("segment 40 should not be ready until MarkReady")
	}
	st.MarkReady(40, 1)
	if !st.IsReady(40) {
		t.Error("segment 40 should be ready after MarkReady")
	}
}

func TestSegmentTable_WaitForCompletesWhenMarkedReady(t *testing.T) {
	t.Parallel()

	st := NewSegmentTable(10)
	kill := make(chan struct{})

	done := make(chan error, 1)
	go func() {
		done <- st.WaitFor(context.Background(), 5, kill)
	}()

	time.Sleep(20 * time.Millisecond)
	st.MarkReady(5, 0)

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("WaitFor returned %v, want nil", err)
		}
	case <-time.After(time.Second):
		t.Fatal("WaitFor did not return after MarkReady")
	}
}
