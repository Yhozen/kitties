package computer

import (
	"context"
	"testing"
)

func TestActivityLeaseIsScopedToItsKitty(t *testing.T) {
	ctx := WithActivity(context.Background(), "kitty-one")
	child, cancel := context.WithCancel(ctx)
	defer cancel()
	if !HasActivity(child, "kitty-one") {
		t.Fatal("child task lost its caller's activity lease")
	}
	if HasActivity(child, "kitty-two") || HasActivity(context.Background(), "kitty-one") || HasActivity(context.Background(), "") {
		t.Fatal("unrelated work borrowed an activity lease")
	}
}
