package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/crypto/curve25519"

	"github.com/iCubeDm/nota-bene-ide/relay/hub"
)

// admin runs a subcommand and returns its stdout and stderr.
func admin(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	var out, errOut bytes.Buffer
	err := adminCommands[args[0]](args[1:], &out, &errOut)
	return out.String(), errOut.String(), err
}

func seedOf(t *testing.T, code string) [32]byte {
	t.Helper()
	code = strings.TrimSpace(code)
	if len(code) != 48 || !strings.HasPrefix(code, codePrefix) {
		t.Fatalf("code %q is not nbk1_ + 43 characters", code)
	}
	k, err := decodeMemberKey(code[len(codePrefix):])
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestInviteWritesPublicHalfOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "members.json")
	out, msg, err := admin(t, "invite", "-members", path, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(out, "\n") != 1 {
		t.Fatalf("stdout is not one code line: %q", out)
	}
	if !strings.Contains(msg, "alice") || strings.Contains(msg, codePrefix) {
		t.Fatalf("stderr %q: names the member, never the code", msg)
	}
	seed := seedOf(t, out)
	fi, err := os.Stat(path)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("members file mode %v %v", fi.Mode(), err)
	}
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), strings.TrimSpace(out)[len(codePrefix):]) {
		t.Fatal("the members file holds the private seed")
	}
	ms, err := loadMembers(path)
	if err != nil {
		t.Fatal(err)
	}
	pub := hub.MemberPub(seed)
	if len(ms) != 1 || ms[0].Name != "alice" || ms[0].Hosts != 3 || ms[0].Key != base64URL.EncodeToString(pub[:]) || len(ms[0].Added) != 10 {
		t.Fatalf("members %+v", ms)
	}
}

func TestInviteRefusesDuplicateAndBadName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "members.json")
	if _, _, err := admin(t, "invite", "-members", path, "-hosts", "5", "alice"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := admin(t, "invite", "-members", path, "alice"); err == nil || !strings.Contains(err.Error(), "already") {
		t.Fatalf("duplicate: %v", err)
	}
	for _, bad := range []string{"a b", "", strings.Repeat("x", 41), "ünï"} {
		if _, _, err := admin(t, "invite", "-members", path, bad); err == nil {
			t.Errorf("name %q accepted", bad)
		}
	}
	if _, _, err := admin(t, "invite", "alice2"); err == nil {
		t.Error("no -members accepted")
	}
	if _, _, err := admin(t, "invite", "-members", path, "-hosts", "0", "bob"); err == nil {
		t.Error("-hosts 0 accepted")
	}
	ms, _ := loadMembers(path)
	if len(ms) != 1 || ms[0].Hosts != 5 {
		t.Fatalf("members %+v", ms)
	}
}

func TestRevokeAndLimitEditFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "members.json")
	for _, n := range []string{"alice", "bob"} {
		if _, _, err := admin(t, "invite", "-members", path, n); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := admin(t, "limit", "-members", path, "bob", "1"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"0", "x", "1.5"} {
		if _, _, err := admin(t, "limit", "-members", path, "bob", bad); err == nil {
			t.Errorf("limit %q accepted", bad)
		}
	}
	if _, _, err := admin(t, "revoke", "-members", path, "alice"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := admin(t, "revoke", "-members", path, "carol"); err == nil {
		t.Error("revoking a stranger succeeded")
	}
	ms, _ := loadMembers(path)
	if len(ms) != 1 || ms[0].Name != "bob" || ms[0].Hosts != 1 {
		t.Fatalf("members %+v", ms)
	}
}

func TestMembersListsWithoutKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "members.json")
	admin(t, "invite", "-members", path, "alice")
	out, _, err := admin(t, "members", "-members", path)
	if err != nil {
		t.Fatal(err)
	}
	ms, _ := loadMembers(path)
	if !strings.Contains(out, "alice") || !strings.Contains(out, "3 hosts") || strings.Contains(out, ms[0].Key) {
		t.Fatalf("members output %q", out)
	}
}

func TestLoadMembersRefusesBadFiles(t *testing.T) {
	dir := t.TempDir()
	key := base64URL.EncodeToString(make([]byte, 32))
	for name, body := range map[string]string{
		"json":     "{",
		"name":     `{"members":[{"name":"a b","key":"` + key + `","hosts":1}]}`,
		"key":      `{"members":[{"name":"a","key":"short","hosts":1}]}`,
		"hosts":    `{"members":[{"name":"a","key":"` + key + `","hosts":0}]}`,
		"twice":    `{"members":[{"name":"a","key":"` + key + `","hosts":1},{"name":"a","key":"` + key + `","hosts":1}]}`,
		"same key": `{"members":[{"name":"a","key":"` + key + `","hosts":1},{"name":"b","key":"` + key + `","hosts":1}]}`,
	} {
		p := filepath.Join(dir, strings.ReplaceAll(name, " ", "_"))
		os.WriteFile(p, []byte(body), 0o600)
		if _, err := loadMembers(p); err == nil {
			t.Errorf("%s: accepted", name)
		} else if strings.Contains(err.Error(), key) {
			t.Errorf("%s: the error quotes a key", name)
		}
	}
}

// lockedBuf is a log sink the test reads while the watcher writes.
type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}
func (l *lockedBuf) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }

// fakeHub records what the watcher asks.
type fakeHub struct {
	mu      sync.Mutex
	revoked [][32]byte
	limits  map[[32]byte]int
}

func (f *fakeHub) Revoke(m [32]byte) { f.mu.Lock(); f.revoked = append(f.revoked, m); f.mu.Unlock() }
func (f *fakeHub) Limit(m [32]byte, n int) {
	f.mu.Lock()
	f.limits[m] = n
	f.mu.Unlock()
}

func eventually(t *testing.T, cond func() bool) {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); !cond(); {
		if time.Now().After(end) {
			t.Fatal("condition not met")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestReloadAppliesChanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "members.json")
	a, _, _ := admin(t, "invite", "-members", path, "alice")
	b, _, _ := admin(t, "invite", "-members", path, "bob")
	alice, bob := hub.MemberPub(seedOf(t, a)), hub.MemberPub(seedOf(t, b))
	ms, err := loadMembers(path)
	if err != nil {
		t.Fatal(err)
	}
	l := newMemberList(ms)
	f := &fakeHub{limits: map[[32]byte]int{}}
	var logs lockedBuf
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go watchMembers(ctx, path, l, f, 20*time.Millisecond, slog.New(slog.NewTextHandler(&logs, nil)))
	time.Sleep(50 * time.Millisecond) // the watcher has taken the first stamp

	admin(t, "revoke", "-members", path, "alice")
	eventually(t, func() bool { f.mu.Lock(); defer f.mu.Unlock(); return len(f.revoked) == 1 && f.revoked[0] == alice })
	if _, ok := l.admit(ctx, "", &alice); ok {
		t.Fatal("a revoked key is still admitted")
	}
	admin(t, "limit", "-members", path, "bob", "1")
	eventually(t, func() bool { f.mu.Lock(); defer f.mu.Unlock(); return f.limits[bob] == 1 })

	os.WriteFile(path, []byte("{ broken"), 0o600)
	eventually(t, func() bool { return strings.Contains(logs.String(), "previous list is kept") })
	if n, ok := l.admit(ctx, "", &bob); !ok || n != 1 {
		t.Fatalf("after a broken file bob = %d %v, want the previous list", n, ok)
	}
	if _, ok := l.admit(ctx, "", nil); ok {
		t.Fatal("a host without a member key admitted")
	}
}

// hostHello connects as a host, optionally signed by seed, and returns the
// relay's answer: "ok" or the close code.
func hostHello(t *testing.T, addr string, seed *[32]byte) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws://"+addr+"/v1/host", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var ch struct{ Eph, Nonce string }
	json.Unmarshal(data, &ch)
	eph, _ := decodeMemberKey(ch.Eph)
	nonce, _ := decodeMemberKey(ch.Nonce)
	var priv [32]byte
	priv[0] = 7
	pubB, _ := curve25519.X25519(priv[:], curve25519.Basepoint)
	pub := [32]byte(pubB)
	m := map[string]any{"t": "hello", "key": base64URL.EncodeToString(pub[:]), "proof": base64URL.EncodeToString(hub.Proof("host", priv, eph, nonce))}
	if seed != nil {
		mp := hub.MemberPub(*seed)
		m["member"] = base64URL.EncodeToString(mp[:])
		m["sig"] = base64URL.EncodeToString(hub.MemberSign(*seed, nonce, eph, pub))
	}
	b, _ := json.Marshal(m)
	c.Write(ctx, websocket.MessageText, b)
	_, data, err = c.Read(ctx)
	if err != nil {
		return websocket.CloseStatus(err).String()
	}
	return strings.Trim(string(data), "{}\"t:")
}

func TestMembersFlagAdmitsOnlyMembers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "members.json")
	if err := run([]string{"-listen", "127.0.0.1:0", "-members", path}, nil); err == nil {
		t.Fatal("a missing members file started the relay")
	}
	code, _, _ := admin(t, "invite", "-members", path, "alice")
	seed := seedOf(t, code)
	ctx, cancel := context.WithCancel(context.Background())
	addrc := make(chan string, 1)
	done := make(chan error, 1)
	go func() {
		done <- runCtx(ctx, []string{"-listen", "127.0.0.1:0", "-members", path}, func(a string) { addrc <- a })
	}()
	defer func() { cancel(); <-done }()
	var addr string
	select {
	case addr = <-addrc:
	case err := <-done:
		t.Fatalf("run ended: %v", err)
	}
	if got := hostHello(t, addr, nil); got != websocket.StatusCode(4402).String() {
		t.Fatalf("no key: %s", got)
	}
	if got := hostHello(t, addr, &seed); got != "ok" {
		t.Fatalf("member: %s", got)
	}
}
