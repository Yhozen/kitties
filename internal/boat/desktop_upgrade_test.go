package boat

import (
	"context"
	"slices"
	"testing"
)

func TestOnlyColdStartsMayActivateGuestDesktopUpgrade(t *testing.T) {
	m, _ := testManager(t, fixture())
	var permissions []bool
	m.runGuest = func(_ context.Context, _ record, stdin string, _ bool, args ...string) ([]byte, error) {
		if stdin != "" {
			permissions = append(permissions, slices.Contains(args, "KITTY_DESKTOP_RESTART=1"))
		}
		return nil, nil
	}
	id := createKitty(t, m)
	if err := m.Start(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if err := m.Stop(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if err := m.Start(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if err := m.Start(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(permissions, []bool{true, false, true, false}) {
		t.Fatalf("upgrade permissions for create,active,resume,active: %v", permissions)
	}
}
