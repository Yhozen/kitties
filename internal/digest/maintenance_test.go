package digest

import (
	"context"
	"errors"
	"github.com/madkoding/kitties/internal/maintenance"
	"testing"
)

func TestBackupBarrierDefersDigestWithoutClaimingDelivery(t *testing.T) {
	rig := newRig(t)
	gate := &maintenance.Gate{}
	rig.r.SetAdmission(gate)
	_, resume, err := gate.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if sent, err := rig.r.Tick(context.Background()); sent || err != nil {
		t.Fatalf("scheduled delivery: %v %v", sent, err)
	}
	if err := rig.r.SendNow(context.Background()); !errors.Is(err, maintenance.ErrBusy) {
		t.Fatalf("manual delivery: %v", err)
	}
	if len(rig.sent) != 0 || rig.r.pending != "" || rig.r.last != "" {
		t.Fatal("digest changed during backup")
	}
	resume()
	if sent, err := rig.r.Tick(context.Background()); !sent || err != nil {
		t.Fatalf("resumed delivery: %v %v", sent, err)
	}
	if len(rig.sent) != 1 {
		t.Fatal("expected one delivery")
	}
}
