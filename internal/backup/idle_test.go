package backup

import (
	"context"
	"errors"
	"testing"
)

func TestWaitIdleIncludesPromotionAndRetentionWithoutCancellingBackup(t *testing.T) {
	for _, phase := range []string{"tag", "forget"} {
		t.Run(phase, func(t *testing.T) {
			options := successfulFixture(t.TempDir())
			entered, finish := make(chan struct{}), make(chan struct{})
			original := options.Run
			options.Run = func(ctx context.Context, dir string, environment []string, args ...string) ([]byte, error) {
				if args[0] == phase {
					close(entered)
					select {
					case <-finish:
					case <-ctx.Done():
						return nil, ctx.Err()
					}
				}
				return original(ctx, dir, environment, args...)
			}
			manager, err := New(options)
			if err != nil {
				t.Fatal(err)
			}
			defer manager.Close()
			if err := manager.WaitIdle(context.Background()); err != nil {
				t.Fatal(err)
			}
			if _, err := manager.Trigger(); err != nil {
				t.Fatal(err)
			}
			<-entered
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if err := manager.WaitIdle(ctx); !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			if !manager.Status().Running {
				t.Fatal("cancelled waiter interrupted backup")
			}
			waited := make(chan error, 1)
			go func() { waited <- manager.WaitIdle(context.Background()) }()
			select {
			case err := <-waited:
				t.Fatalf("wait ended before %s: %v", phase, err)
			default:
			}
			close(finish)
			if err := <-waited; err != nil {
				t.Fatal(err)
			}
			if status := manager.Status(); status.Running || status.LastSuccess.IsZero() {
				t.Fatalf("idle acknowledged before backup completion: %+v", status)
			}
		})
	}
}
