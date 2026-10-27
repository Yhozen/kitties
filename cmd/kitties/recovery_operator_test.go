package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func recoveryOperatorServer(t *testing.T, rejectPrepare bool) *[]string {
	t.Helper()
	actions := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-operator-token" {
			t.Error("missing operator authorization")
		}
		var body struct {
			OperationID string `json:"operation_id"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.OperationID != "recovery_00000001" {
			t.Error("wrong operation")
		}
		action := strings.TrimPrefix(r.URL.Path, "/v1/operator/recovery/")
		actions = append(actions, action)
		if rejectPrepare && action == "prepare" {
			w.WriteHeader(http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	t.Setenv("KITTIES_TOKEN", "fixture-operator-token")
	t.Setenv("KITTIES_LISTEN", strings.TrimPrefix(server.URL, "http://"))
	return &actions
}

func TestVerifyRecoveryReleasesHoldOnVerificationOrPrepareFailure(t *testing.T) {
	for _, rejectPrepare := range []bool{false, true} {
		t.Run(map[bool]string{false: "verification fails", true: "prepare fails"}[rejectPrepare], func(t *testing.T) {
			actions := recoveryOperatorServer(t, rejectPrepare)
			t.Setenv("RESTIC_REPOSITORY", filepath.Join(t.TempDir(), "missing"))
			t.Setenv("RESTIC_PASSWORD", "fixture-password")
			var out, errs bytes.Buffer
			if code := cmdVerifyRecovery([]string{strings.Repeat("a", 64), "--freeze", "recovery_00000001"}, &out, &errs); code != 1 {
				t.Fatal(code)
			}
			if strings.Join(*actions, ",") != "prepare,release" {
				t.Fatalf("failure left hold: %v", *actions)
			}
		})
	}
}

func TestVerifiedRecoveryKeepsHoldUntilExplicitRelease(t *testing.T) {
	snapshot, _ := recoveryRepository(t)
	actions := recoveryOperatorServer(t, false)
	var out, errs bytes.Buffer
	if code := cmdVerifyRecovery([]string{snapshot, "--freeze", "recovery_00000001"}, &out, &errs); code != 0 {
		t.Fatalf("verify=%d: %s", code, errs.String())
	}
	if strings.Join(*actions, ",") != "prepare" {
		t.Fatalf("successful verification released hold: %v", *actions)
	}
	if code := cmdReleaseRecovery([]string{"recovery_00000001"}, &out, &errs); code != 0 {
		t.Fatal(code)
	}
	if strings.Join(*actions, ",") != "prepare,release" {
		t.Fatal(*actions)
	}
}

func TestCloudRestoreDoesNotImportPriorGatewayOperatorHold(t *testing.T) {
	snapshot, _ := recoveryRepository(t, func(stage string) {
		if err := os.WriteFile(filepath.Join(stage, "gateway", "recovery-freeze.json"), []byte(`{"active":"recovery_00000001"}`), 0o600); err != nil {
			t.Fatal(err)
		}
	})
	service, endpoint := newGatewayStateService(t)
	t.Setenv("KITTIES_RESTORE_SNAPSHOT", snapshot)
	if err := prepareCloudRestore(t.Context(), endpoint); err != nil {
		t.Fatal(err)
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	for _, file := range service.files {
		if file.Path == "recovery-freeze.json" {
			t.Fatal("imported source gateway operator hold")
		}
	}
}
