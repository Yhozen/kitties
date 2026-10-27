package config

import (
	"strings"
	"testing"
)

func TestBoatDefaultsAndPrivateGateway(t *testing.T) {
	cfg, err := Parse([]byte("containers:\n  runtime: boat\n"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Boat.APIKeyEnv != "BOAT_DEV_API_KEY" || cfg.Boat.Size != "small" || cfg.Boat.MaxRunning != 5 || cfg.Boat.IdleMinutes != 15 || cfg.Boat.TTLMinutes != 60 || cfg.Boat.RenewMinutes != 5 {
		t.Fatalf("unexpected defaults: %+v", cfg.Boat)
	}
	if cfg.Containers.AutoUpdate || cfg.Gateway.LocalTokenAllowed() {
		t.Fatal("cloud configuration allows desktop replacement or unauthenticated token retrieval")
	}
}

func TestBoatRejectsUnsafeConfiguration(t *testing.T) {
	for _, input := range []string{
		"containers:\n  runtime: boat\n  workspace: /home/user\n",
		"containers:\n  runtime: boat\nboat:\n  max_running: 6\n",
		"containers:\n  runtime: boat\nboat:\n  renew_minutes: 60\n",
		"containers:\n  runtime: boat\ngateway:\n  local_token: true\n",
	} {
		if _, err := Parse([]byte(input)); err == nil {
			t.Errorf("accepted %q", input)
		}
	}
	cfg, err := Parse([]byte("containers:\n  runtime: boat\nboat:\n  api_key_env: MY_BOAT_KEY\n  size: large\n  max_running: 2\n"))
	if err != nil || !strings.EqualFold(cfg.Boat.Size, "large") || cfg.Boat.APIKeyEnv != "MY_BOAT_KEY" || cfg.Boat.MaxRunning != 2 {
		t.Fatalf("custom profile: %+v, %v", cfg.Boat, err)
	}
}
