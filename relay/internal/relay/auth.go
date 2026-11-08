// Package relay is a stateless WebSocket relay between Nota Bene hosts and devices.
package relay

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"

	"golang.org/x/crypto/curve25519"
)

const label = "nb-relay-v1 "

var b64 = base64.RawURLEncoding

// Challenge is the per-connection admission challenge: a fresh relay X25519
// key pair and a nonce. ephPriv never leaves the relay.
type Challenge struct {
	EphPub  [32]byte
	Nonce   [32]byte
	ephPriv [32]byte
}

// NewChallenge makes a fresh challenge.
func NewChallenge() (Challenge, error) {
	var c Challenge
	if _, err := rand.Read(c.ephPriv[:]); err != nil {
		return Challenge{}, err
	}
	if _, err := rand.Read(c.Nonce[:]); err != nil {
		return Challenge{}, err
	}
	pub, err := curve25519.X25519(c.ephPriv[:], curve25519.Basepoint)
	if err != nil {
		return Challenge{}, err
	}
	copy(c.EphPub[:], pub)
	return c, nil
}

// mac is HMAC-SHA256(key = X25519(priv, peer), message = label+role ‖ nonce).
// It returns nil for an unknown role or an all-zero (low-order) shared secret.
func mac(role string, priv, peer, nonce [32]byte) []byte {
	if role != "host" && role != "device" {
		return nil
	}
	shared, err := curve25519.X25519(priv[:], peer[:])
	if err != nil { // x/crypto reports an all-zero result as an error
		return nil
	}
	h := hmac.New(sha256.New, shared)
	h.Write([]byte(label + role))
	h.Write(nonce[:])
	return h.Sum(nil)
}

// Verify reports whether proof shows that the holder of the private key for
// pub answered this challenge in the given role ("host" or "device").
func (c Challenge) Verify(role string, pub [32]byte, proof []byte) bool {
	want := mac(role, c.ephPriv, pub, c.Nonce)
	return want != nil && hmac.Equal(want, proof)
}

// Proof is the client side of the admission proof. It returns nil for a role
// other than "host" or "device" or for a degenerate ephPub.
func Proof(role string, priv, ephPub, nonce [32]byte) []byte {
	return mac(role, priv, ephPub, nonce)
}

// HostID is the host's public key as base64url without padding.
func HostID(pub [32]byte) string { return b64.EncodeToString(pub[:]) }

// DeviceHash is base64url(SHA-256(device public key)).
func DeviceHash(pub [32]byte) string {
	sum := sha256.Sum256(pub[:])
	return b64.EncodeToString(sum[:])
}

// decodeKey parses a 32-byte key in unpadded base64url.
func decodeKey(s string) ([32]byte, error) {
	var k [32]byte
	raw, err := b64.Strict().DecodeString(s)
	if err != nil {
		return k, err
	}
	if len(raw) != len(k) {
		return k, errors.New("key must be 32 bytes")
	}
	copy(k[:], raw)
	return k, nil
}
