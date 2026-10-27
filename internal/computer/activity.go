package computer

import "context"

type activityKey struct{}

// WithActivity marks work already protected by the caller's lifetime lease.
func WithActivity(ctx context.Context, kittyID string) context.Context {
	return context.WithValue(ctx, activityKey{}, kittyID)
}

func HasActivity(ctx context.Context, kittyID string) bool {
	return ctx.Value(activityKey{}) == kittyID
}
