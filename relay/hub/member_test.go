package hub

import (
	"context"
	"sync"
	"testing"
	"time"
)

// seqBytes is 32 bytes counting up from first.
func seqBytes(first byte) [32]byte {
	var k [32]byte
	for i := range k {
		k[i] = first + byte(i)
	}
	return k
}

// dialMemberNoWait sends a host hello signed by the member key seed; extra
// fields replace the computed ones (to send a malformed member or signature).
func dialMemberNoWait(t *testing.T, url string, priv [32]byte, seed [32]byte, extra map[string]any) *testHost {
	t.Helper()
	r := dialRaw(t, url+"/v1/host")
	pub := pubOf(t, priv)
	mpub := MemberPub(seed)
	m := map[string]any{
		"devices": []string{},
		"member":  b64.EncodeToString(mpub[:]),
		"sig":     b64.EncodeToString(MemberSign(seed, r.nonce, r.eph, pub)),
	}
	for k, v := range extra {
		m[k] = v
	}
	r.hello("host", priv, pub, m)
	return &testHost{t: t, c: r.c, priv: priv, pub: pub, id: HostID(pub)}
}

func dialMember(t *testing.T, url string, priv, seed [32]byte) *testHost {
	t.Helper()
	h := dialMemberNoWait(t, url, priv, seed, nil)
	if m := h.nextJSON(); m["t"] != "ok" {
		t.Fatalf("member host answered %v", m)
	}
	return h
}

// members is a test Admit hook: known member keys and their host limits.
type members struct {
	mu    sync.Mutex
	limit map[[32]byte]int
}

func (m *members) admit(_ context.Context, _ string, member *[32]byte) (int, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if member == nil {
		return 0, false
	}
	n, ok := m.limit[*member]
	return n, ok
}

func keyedServer(t *testing.T, limits map[[32]byte]int) (*Server, string) {
	t.Helper()
	o := DefaultOptions()
	o.Admit = (&members{limit: limits}).admit
	return newTestServer(t, o)
}

func waitHosts(t *testing.T, s *Server, want int) {
	t.Helper()
	deadline := time.Now().Add(testWait)
	for {
		if n, _ := s.Stats(); n == want {
			return
		}
		if time.Now().After(deadline) {
			n, _ := s.Stats()
			t.Fatalf("hosts %d, want %d", n, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestMemberSignVector(t *testing.T) {
	seed := seqBytes(0x41)
	eph, _ := decodeKey("ZLEBsdC-WocEvQePmJUAH8A-jp-VIvGI3RKNmEbUhGY")
	nonce := seqBytes(0x61)
	host := pubOf(t, seqBytes(0x21))
	pub := MemberPub(seed)
	sig := MemberSign(seed, nonce, eph, host)
	if !VerifyMember(pub, nonce, eph, host, sig) {
		t.Fatal("own signature refused")
	}
	other := seqBytes(0x01)
	for name, ok := range map[string]bool{
		"nonce": VerifyMember(pub, other, eph, host, sig),
		"eph":   VerifyMember(pub, nonce, other, host, sig),
		"host":  VerifyMember(pub, nonce, eph, other, sig),
		"short": VerifyMember(pub, nonce, eph, host, sig[:63]),
	} {
		if ok {
			t.Errorf("signature accepted with another %s", name)
		}
	}
	bad := append([]byte{}, sig...)
	bad[10] ^= 1
	if VerifyMember(pub, nonce, eph, host, bad) {
		t.Error("altered signature accepted")
	}
}

func TestMemberRequiredWithHook(t *testing.T) {
	seed := seqBytes(0x41)
	_, url := keyedServer(t, map[[32]byte]int{MemberPub(seed): 3})
	hpriv, _ := keyPair(t)

	if c := closeCode(t, dialHostNoWait(t, url, hpriv, nil, nil).c); c != 4402 {
		t.Fatalf("no member: %d", c)
	}
	if c := closeCode(t, dialMemberNoWait(t, url, hpriv, seqBytes(0x01), nil).c); c != 4402 {
		t.Fatalf("unknown member: %d", c)
	}
	badSig := b64.EncodeToString(make([]byte, 64))
	if c := closeCode(t, dialMemberNoWait(t, url, hpriv, seed, map[string]any{"sig": badSig}).c); c != 4402 {
		t.Fatalf("bad signature: %d", c)
	}
	if c := closeCode(t, dialMemberNoWait(t, url, hpriv, seed, map[string]any{"member": "short"}).c); c != 4402 {
		t.Fatalf("malformed member: %d", c)
	}
	dialMember(t, url, hpriv, seed)
}

func TestOpenRelayIgnoresMember(t *testing.T) {
	_, url := newTestServer(t, DefaultOptions())
	hpriv, _ := keyPair(t)
	h := dialMemberNoWait(t, url, hpriv, seqBytes(0x41), map[string]any{"member": "short", "sig": "x"})
	if m := h.nextJSON(); m["t"] != "ok" {
		t.Fatalf("open relay answered %v", m)
	}
}

func TestMemberHostLimit(t *testing.T) {
	seed := seqBytes(0x41)
	s, url := keyedServer(t, map[[32]byte]int{MemberPub(seed): 2})
	a, _ := keyPair(t)
	b, _ := keyPair(t)
	c, _ := keyPair(t)
	dialMember(t, url, a, seed)
	hb := dialMember(t, url, b, seed)
	if code := closeCode(t, dialMemberNoWait(t, url, c, seed, nil).c); code != 4405 {
		t.Fatalf("third host: %d", code)
	}
	// a reconnect of a connected host is a replacement, not a third host
	dialMember(t, url, a, seed)
	waitHosts(t, s, 2)
	hb.c.CloseNow()
	waitHosts(t, s, 1)
	dialMember(t, url, c, seed)
}

func TestHostMovesKey(t *testing.T) {
	k1, k2 := seqBytes(0x41), seqBytes(0x51)
	s, url := keyedServer(t, map[[32]byte]int{MemberPub(k1): 1, MemberPub(k2): 1})
	a, _ := keyPair(t)
	b, _ := keyPair(t)
	dialMember(t, url, a, k1)
	if code := closeCode(t, dialMemberNoWait(t, url, b, k1, nil).c); code != 4405 {
		t.Fatalf("second host on k1: %d", code)
	}
	dialMember(t, url, a, k2) // replaces a; k1's slot is free again
	waitHosts(t, s, 1)
	dialMember(t, url, b, k1)
}

func TestRevokeAndLimit(t *testing.T) {
	k1, k2 := seqBytes(0x41), seqBytes(0x51)
	s, url := keyedServer(t, map[[32]byte]int{MemberPub(k1): 3, MemberPub(k2): 3})
	a, _ := keyPair(t)
	b, _ := keyPair(t)
	c, _ := keyPair(t)
	ha := dialMember(t, url, a, k1)
	hb := dialMember(t, url, b, k1)
	hc := dialMember(t, url, c, k2)

	s.Limit(MemberPub(k1), 1)
	if code := closeCode(t, hb.c); code != 4405 {
		t.Fatalf("later host after a lowered limit: %d", code)
	}
	waitHosts(t, s, 2)
	s.Revoke(MemberPub(k1))
	if code := closeCode(t, ha.c); code != 4402 {
		t.Fatalf("revoked host: %d", code)
	}
	waitHosts(t, s, 1)
	hc.sendJSON(map[string]any{"t": "ticket", "ticket": nil}) // k2's host is untouched
}

func TestRevokeDuringAdmission(t *testing.T) {
	seed := seqBytes(0x41)
	o := DefaultOptions()
	asked, release := make(chan struct{}), make(chan struct{})
	o.Admit = func(_ context.Context, _ string, m *[32]byte) (int, bool) {
		close(asked)
		<-release
		return 3, m != nil
	}
	s, url := newTestServer(t, o)
	hpriv, _ := keyPair(t)
	h := dialMemberNoWait(t, url, hpriv, seed, nil)
	<-asked
	s.Revoke(MemberPub(seed))
	close(release)
	if code := closeCode(t, h.c); code != 4402 {
		t.Fatalf("host admitted across a revoke: %d", code)
	}
}
