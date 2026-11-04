package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"time"
)

var recoveryOperationID = regexp.MustCompile(`^[a-zA-Z0-9_-]{16,64}$`)

func recoveryControl(ctx context.Context, action, id string) error {
	if !recoveryOperationID.MatchString(id) {
		return errors.New("invalid recovery operation ID")
	}
	token := os.Getenv("KITTIES_TOKEN")
	if token == "" {
		return errors.New("recovery control requires KITTIES_TOKEN")
	}
	listen := os.Getenv("KITTIES_LISTEN")
	if listen == "" {
		listen = "127.0.0.1:7488"
	}
	_, port, err := net.SplitHostPort(listen)
	if err != nil {
		return errors.New("invalid local gateway listen address")
	}
	raw, _ := json.Marshal(map[string]string{"operation_id": id})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+net.JoinHostPort("127.0.0.1", port)+"/v1/operator/recovery/"+action, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Transport: &http.Transport{}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	response, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("local recovery control: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("local recovery %s returned HTTP %d", action, response.StatusCode)
	}
	return nil
}

func releaseRecovery(id string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return recoveryControl(ctx, "release", id)
}

func cmdReleaseRecovery(args []string, out, errOut io.Writer) int {
	if len(args) != 1 {
		fmt.Fprintln(errOut, "usage: kitties release-recovery <operation-id>")
		return 2
	}
	if err := releaseRecovery(args[0]); err != nil {
		fmt.Fprintf(errOut, "kitties: recovery release failed: %v\n", err)
		return 1
	}
	fmt.Fprintln(out, "Recovery hold released")
	return 0
}
