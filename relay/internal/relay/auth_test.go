package relay

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"testing"

	"golang.org/x/crypto/curve25519"
)

func keyPair(t *testing.T) (priv, pub [32]byte) {
	t.Helper()
	if _, err := rand.Read(priv[:]); err != nil {
		t.Fatal(err)
	}
	p, err := curve25519.X25519(priv[:], curve25519.Basepoint)
	if err != nil {
		t.Fatal(err)
	}
	copy(pub[:], p)
	return
}

func newChallenge(t *testing.T) Challenge {
	t.Helper()
	c, err := NewChallenge()
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestProofRoundTrip(t *testing.T) {
	priv, pub := keyPair(t)
	c := newChallenge(t)
	for _, role := range []string{"host", "device"} {
		if !c.Verify(role, pub, Proof(role, priv, c.EphPub, c.Nonce)) {
			t.Errorf("%s proof rejected", role)
		}
	}
}

func TestProofWrongRole(t *testing.T) {
	priv, pub := keyPair(t)
	c := newChallenge(t)
	if c.Verify("device", pub, Proof("host", priv, c.EphPub, c.Nonce)) {
		t.Error("host proof accepted as device")
	}
	if c.Verify("admin", pub, Proof("host", priv, c.EphPub, c.Nonce)) {
		t.Error("unknown role accepted")
	}
}

func TestProofWrongKey(t *testing.T) {
	priv, _ := keyPair(t)
	_, other := keyPair(t)
	c := newChallenge(t)
	if c.Verify("host", other, Proof("host", priv, c.EphPub, c.Nonce)) {
		t.Error("proof accepted for another public key")
	}
}

func TestProofOtherChallenge(t *testing.T) {
	priv, pub := keyPair(t)
	a, b := newChallenge(t), newChallenge(t)
	if b.Verify("host", pub, Proof("host", priv, a.EphPub, a.Nonce)) {
		t.Error("proof for one challenge accepted by another")
	}
}

func TestProofBadInput(t *testing.T) {
	_, pub := keyPair(t)
	c := newChallenge(t)
	if c.Verify("host", pub, nil) || c.Verify("host", pub, make([]byte, 32)) {
		t.Error("empty or zero proof accepted")
	}
	// A low-order public key yields an all-zero shared secret: never admitted.
	var zero [32]byte
	if c.Verify("host", zero, make([]byte, 32)) {
		t.Error("all-zero key accepted")
	}
}

func TestIDs(t *testing.T) {
	_, pub := keyPair(t)
	id := HostID(pub)
	if len(id) != 43 {
		t.Fatalf("host id length %d", len(id))
	}
	if got, err := decodeKey(id); err != nil || got != pub {
		t.Fatalf("decodeKey round trip: %v", err)
	}
	sum := sha256.Sum256(pub[:])
	if DeviceHash(pub) != base64.RawURLEncoding.EncodeToString(sum[:]) {
		t.Error("DeviceHash is not base64url(SHA-256(pub))")
	}
	for _, n := range []int{31, 33} {
		if _, err := decodeKey(base64.RawURLEncoding.EncodeToString(make([]byte, n))); err == nil {
			t.Errorf("decodeKey accepted %d bytes", n)
		}
	}
	if _, err := decodeKey(base64.URLEncoding.EncodeToString(make([]byte, 32))); err == nil {
		t.Error("decodeKey accepted padded input")
	}
}
