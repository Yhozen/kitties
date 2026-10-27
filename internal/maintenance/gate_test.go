package maintenance

import (
	"context"
	"errors"
	"testing"
)

func TestMaintenanceDrainsExistingWorkAndRejectsNewWork(t *testing.T) {
	var gate Gate
	ctx, finish, err := gate.Enter(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	waiting, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan func(), 1)
	go func() {
		_, resume, err := gate.Begin(waiting)
		if err != nil {
			ready <- nil
			return
		}
		ready <- resume
	}()
	for {
		gate.mu.Lock()
		blocked, changed := gate.blocked, gate.changed
		gate.mu.Unlock()
		if blocked {
			break
		}
		if changed != nil {
			<-changed
		}
	}
	if _, _, err := gate.Enter(context.Background()); !errors.Is(err, ErrBusy) {
		t.Fatalf("new work admitted: %v", err)
	}
	_, nestedFinish, err := gate.Enter(ctx)
	if err != nil {
		t.Fatalf("interrupted admitted work: %v", err)
	}
	finish()
	select {
	case <-ready:
		t.Fatal("maintenance crossed active child")
	default:
	}
	nestedFinish()
	resume := <-ready
	if resume == nil {
		t.Fatal("maintenance failed")
	}
	if _, _, err := gate.Enter(ctx); !errors.Is(err, ErrBusy) {
		t.Fatal("expired admission bypassed maintenance")
	}
	resume()
	_, finish, err = gate.Enter(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	finish()
}

func TestCancelledDrainReopensAdmission(t *testing.T) {
	var gate Gate
	_, finish, _ := gate.Enter(context.Background())
	defer finish()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := gate.Begin(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("drain = %v", err)
	}
	_, release, err := gate.Enter(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	release()
}

func TestMaintenancePrivilegeAndCancellationAreScoped(t *testing.T) {
	var gate Gate
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := gate.Enter(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	owner, resume, err := gate.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !gate.Owns(owner) || !gate.Active() || !gate.Busy() {
		t.Fatal("maintenance ownership not visible")
	}
	if _, _, err := gate.TryBegin(context.Background()); !errors.Is(err, ErrBusy) {
		t.Fatal("second owner admitted")
	}
	_, finish, err := gate.Enter(owner)
	if err != nil {
		t.Fatal(err)
	}
	finish()
	resume()
	resume()
	if gate.Owns(owner) || gate.Active() || gate.Busy() {
		t.Fatal("expired owner retained privilege")
	}
	_, finish, err = gate.Enter(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := gate.TryBegin(context.Background()); !errors.Is(err, ErrBusy) {
		t.Fatal("idle backup crossed active work")
	}
	finish()
}

func TestRecoveryFreezeWaitsForBackupOwnerAndOutlivesItsRelease(t *testing.T) {
	var gate Gate
	owner, finishBackup, err := gate.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer finishBackup()
	prepared := make(chan error, 1)
	go func() { prepared <- gate.Freeze(context.Background()) }()
	for {
		gate.mu.Lock()
		frozen, changed := gate.frozen, gate.changed
		gate.mu.Unlock()
		if frozen {
			break
		}
		<-changed
	}
	_, child, err := gate.Enter(owner)
	if err != nil {
		t.Fatalf("freeze interrupted backup resume: %v", err)
	}
	child()
	select {
	case <-prepared:
		t.Fatal("freeze crossed backup owner")
	default:
	}
	finishBackup()
	if err := <-prepared; err != nil {
		t.Fatal(err)
	}
	if _, _, err := gate.Enter(context.Background()); !errors.Is(err, ErrBusy) {
		t.Fatal("backup release reopened recovery freeze")
	}
	gate.Thaw()
	_, finish, err := gate.Enter(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	finish()
}
