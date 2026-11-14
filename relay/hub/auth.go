// Package hub is the Nota Bene relay: a stateless WebSocket hub between hosts
// and their devices. See PROTOCOL.md for the wire contract.
package hub

import (
	"crypto/ed25519"
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

const memberLabel = "nb-relay-v1 member"

// memberMessage is what a member key signs in a host hello: the label, then the
// challenge's nonce and eph and the host's key, so a signature admits only this
// host key on this connection.
func memberMessage(nonce, eph, hostKey [32]byte) []byte {
	m := make([]byte, 0, len(memberLabel)+96)
	m = append(m, memberLabel...)
	m = append(m, nonce[:]...)
	m = append(m, eph[:]...)
	return append(m, hostKey[:]...)
}

// MemberPub is the public half of a member key given by its 32-byte seed.
func MemberPub(seed [32]byte) [32]byte {
	var pub [32]byte
	copy(pub[:], ed25519.NewKeyFromSeed(seed[:]).Public().(ed25519.PublicKey))
	return pub
}

// MemberSign is the client side of the member signature (Ed25519, 64 bytes).
func MemberSign(seed [32]byte, nonce, eph, hostKey [32]byte) []byte {
	return ed25519.Sign(ed25519.NewKeyFromSeed(seed[:]), memberMessage(nonce, eph, hostKey))
}

// VerifyMember reports whether sig is the member key pub's signature for this
// challenge and host key.
func VerifyMember(pub [32]byte, nonce, eph, hostKey [32]byte, sig []byte) bool {
	return len(sig) == ed25519.SignatureSize && ed25519.Verify(pub[:], memberMessage(nonce, eph, hostKey), sig)
}

// sigLen is the length of 64 bytes in unpadded base64url.
const sigLen = 86

func decodeSig(s string) ([]byte, error) {
	if len(s) != sigLen {
		return nil, errors.New("signature must be 86 base64url characters")
	}
	raw, err := b64.Strict().DecodeString(s)
	if err != nil {
		return nil, err
	}
	if len(raw) != ed25519.SignatureSize {
		return nil, errors.New("signature must be 64 bytes")
	}
	return raw, nil
}

// HostID is the host's public key as base64url without padding.
func HostID(pub [32]byte) string { return b64.EncodeToString(pub[:]) }

// DeviceHash is base64url(SHA-256(device public key)).
func DeviceHash(pub [32]byte) string {
	sum := sha256.Sum256(pub[:])
	return b64.EncodeToString(sum[:])
}

// keyLen is the length of 32 bytes in unpadded base64url.
const keyLen = 43

// decodeKey parses a 32-byte value (a key, ticket or device hash) in unpadded
// base64url: exactly 43 characters. The length check also refuses CR and LF,
// which the strict decoder would otherwise skip.
func decodeKey(s string) ([32]byte, error) {
	var k [32]byte
	if len(s) != keyLen {
		return k, errors.New("key must be 43 base64url characters")
	}
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
