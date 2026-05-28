package cassette

import "testing"

// Regression: KeyframeIndex.Get(idx) used to panic with "index out of range"
// when idx >= len(Keyframes). The crash was reachable from Pipeline.GetSegment
// via minHeadDistance when a client requested a segment past file end after
// a long pause (observed on 2026-05-27 with idx=328, len=328).
func TestKeyframeIndex_GetOutOfRange(t *testing.T) {
	t.Parallel()

	ki := &KeyframeIndex{Keyframes: []float64{0.0, 1.0, 2.0, 3.0}}

	cases := []int32{-1, 4, 100, 1 << 20}
	for _, idx := range cases {
		v := ki.Get(idx)
		if v != 0 {
			t.Errorf("Get(%d) on len=4 should return 0, got %f", idx, v)
		}
	}

	// In-range still works.
	if got := ki.Get(2); got != 2.0 {
		t.Errorf("Get(2) = %f, want 2.0", got)
	}
}

func TestKeyframeIndex_SliceClamps(t *testing.T) {
	t.Parallel()

	ki := &KeyframeIndex{Keyframes: []float64{0.0, 1.0, 2.0, 3.0, 4.0}}

	if got := ki.Slice(-1, 3); got != nil {
		t.Errorf("Slice(-1, 3) should return nil (negative start), got %v", got)
	}
	if got := ki.Slice(5, 10); got != nil {
		t.Errorf("Slice(5, 10) past end should return nil, got %v", got)
	}
	if got := ki.Slice(3, 2); got != nil {
		t.Errorf("Slice with end<=start should return nil, got %v", got)
	}

	// End clamped to length.
	got := ki.Slice(2, 100)
	want := []float64{2.0, 3.0, 4.0}
	if len(got) != len(want) {
		t.Fatalf("Slice(2, 100) len = %d, want %d", len(got), len(want))
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("Slice(2, 100)[%d] = %f, want %f", i, got[i], want[i])
		}
	}
}
