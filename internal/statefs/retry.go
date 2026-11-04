package statefs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

type statusError struct{ status int }

func (e *statusError) Error() string {
	return fmt.Sprintf("state service returned HTTP %d", e.status)
}

// Only immutable uploads and requests with a durable idempotency receipt may use this.
func retryWrite(ctx context.Context, write func() error) error {
	for attempt := 0; ; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := write()
		if err == nil || attempt == 2 || !retryable(err) {
			return err
		}
		// R2 allows one write per key per second. Leave that window before retrying.
		timer := time.NewTimer(time.Second << attempt)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func retryable(err error) bool {
	var status *statusError
	if errors.As(err, &status) {
		return status.status == 429 || status.status >= 500 && status.status <= 599
	}
	var network net.Error
	return errors.As(err, &network) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
}
