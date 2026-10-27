package vault

import (
	"errors"
	"strings"
)

// ValidateKey verifies stored ciphertext before a cloud gateway accepts work.
func (s *Store) ValidateKey() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, entry := range s.list {
		if len(entry.Nonce) != s.aead.NonceSize() {
			return errors.New("saved secrets contain an invalid nonce")
		}
		if _, err := s.aead.Open(nil, entry.Nonce, entry.Sealed, []byte(strings.ToLower(entry.Name))); err != nil {
			return errors.New("saved secrets cannot be opened with the configured encryption key")
		}
	}
	return nil
}
