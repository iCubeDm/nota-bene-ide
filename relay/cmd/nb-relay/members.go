package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/iCubeDm/nota-bene-ide/relay/hub"
)

// An access key is given to a person as "nbk1_" + base64url(the 32-byte
// Ed25519 seed). The members file keeps only the public half.
const (
	codePrefix   = "nbk1_"
	defaultHosts = 3
)

var nameRE = regexp.MustCompile(`^[A-Za-z0-9._-]{1,40}$`)

// member is one entry of the members file.
type member struct {
	Name  string `json:"name"`
	Key   string `json:"key"`   // base64url of the Ed25519 public key
	Hosts int    `json:"hosts"` // hosts connected at once with this key
	Added string `json:"added"` // YYYY-MM-DD
}

type membersFile struct {
	Members []member `json:"members"`
}

// loadMembers reads and checks the members file. Its errors name the entry by
// position and never quote a key.
func loadMembers(path string) ([]member, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var f membersFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("%s: not a members file: %v", path, err)
	}
	names, keys := map[string]bool{}, map[string]bool{}
	for i, m := range f.Members {
		switch {
		case !nameRE.MatchString(m.Name):
			return nil, fmt.Errorf("%s: member %d: the name must be 1-40 letters, digits, '.', '_' or '-'", path, i+1)
		case names[m.Name]:
			return nil, fmt.Errorf("%s: member %d: the name %s is used twice", path, i+1, m.Name)
		case m.Hosts < 1:
			return nil, fmt.Errorf("%s: member %d: hosts must be at least 1", path, i+1)
		}
		if _, err := decodeMemberKey(m.Key); err != nil || keys[m.Key] {
			return nil, fmt.Errorf("%s: member %d: bad or repeated key", path, i+1)
		}
		names[m.Name], keys[m.Key] = true, true
	}
	return f.Members, nil
}

func decodeMemberKey(s string) ([32]byte, error) {
	var k [32]byte
	raw, err := base64.RawURLEncoding.Strict().DecodeString(s)
	if err != nil || len(s) != 43 || len(raw) != 32 {
		return k, errors.New("a member key is 43 base64url characters")
	}
	copy(k[:], raw)
	return k, nil
}

// saveMembers replaces the file atomically, readable by its owner only.
func saveMembers(path string, ms []member) error {
	if ms == nil {
		ms = []member{}
	}
	data, err := json.MarshalIndent(membersFile{Members: ms}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".members-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // gone after the rename; cleans up on failure
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil { // a crash must not leave a truncated file the relay cannot start with
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// memberList is the relay's current view of the file, behind the Admit hook.
type memberList struct {
	mu    sync.Mutex
	hosts map[[32]byte]int
}

func newMemberList(ms []member) *memberList {
	l := &memberList{}
	l.set(ms)
	return l
}

// set replaces the list and returns the previous and the new one.
func (l *memberList) set(ms []member) (prev, next map[[32]byte]int) {
	next = make(map[[32]byte]int, len(ms))
	for _, m := range ms {
		k, _ := decodeMemberKey(m.Key) // checked by loadMembers
		next[k] = m.Hosts
	}
	l.mu.Lock()
	prev = l.hosts
	l.hosts = next
	l.mu.Unlock()
	return prev, next
}

func (l *memberList) admit(_ context.Context, _ string, key *[32]byte) (int, bool) {
	if key == nil {
		return 0, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	n, ok := l.hosts[*key]
	return n, ok
}

// enforcer is what the watcher asks of the hub.
type enforcer interface {
	Revoke(member [32]byte)
	Limit(member [32]byte, hosts int)
}

// watchMembers re-reads the file whenever its modification time or size
// changes and applies removals and lowered limits to connected hosts. A file
// that does not load is logged and the previous list kept.
func watchMembers(ctx context.Context, path string, l *memberList, h enforcer, every time.Duration, log *slog.Logger) {
	// every save renames a new file in, so the file's identity changes even when its time and size do not
	stamp := func() os.FileInfo {
		fi, _ := os.Stat(path)
		return fi
	}
	same := func(a, b os.FileInfo) bool {
		return a != nil && b != nil && os.SameFile(a, b) && a.ModTime().Equal(b.ModTime()) && a.Size() == b.Size()
	}
	var last os.FileInfo // nil: the first tick reloads, covering an edit since the start's load
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		fi := stamp()
		if same(fi, last) {
			continue
		}
		last = fi
		ms, err := loadMembers(path)
		if err != nil {
			log.Error("members file not reloaded, the previous list is kept", "err", err)
			continue
		}
		prev, now := l.set(ms)
		for k, n := range prev {
			if m, ok := now[k]; !ok {
				h.Revoke(k)
			} else if m < n {
				h.Limit(k, m)
			}
		}
		log.Info("members reloaded", "members", len(ms))
	}
}

// adminCommands are the subcommands that edit the members file.
var adminCommands = map[string]func(args []string, out, errOut io.Writer) error{
	"invite":  invite,
	"revoke":  revoke,
	"members": listMembers,
	"limit":   limit,
}

func adminFlags(name string, errOut io.Writer) (*flag.FlagSet, *string) {
	fs := flag.NewFlagSet("nb-relay "+name, flag.ContinueOnError)
	fs.SetOutput(errOut)
	path := fs.String("members", "", "the members file (required)")
	return fs, path
}

func parseAdmin(fs *flag.FlagSet, path *string, args []string, want int, usage string) ([]string, error) {
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if *path == "" || fs.NArg() != want {
		return nil, fmt.Errorf("usage: nb-relay %s", usage)
	}
	return fs.Args(), nil
}

func findMember(ms []member, name string) int {
	for i, m := range ms {
		if m.Name == name {
			return i
		}
	}
	return -1
}

func invite(args []string, out, errOut io.Writer) error {
	fs, path := adminFlags("invite", errOut)
	hosts := fs.Int("hosts", defaultHosts, "computers connected at once with this key")
	rest, err := parseAdmin(fs, path, args, 1, "invite -members FILE [-hosts N] NAME")
	if err != nil {
		return err
	}
	name := rest[0]
	if !nameRE.MatchString(name) {
		return errors.New("the name must be 1-40 letters, digits, '.', '_' or '-'")
	}
	if *hosts < 1 {
		return errors.New("-hosts must be at least 1")
	}
	// read, change and write under the lock: two subcommands at once cannot undo each other's change
	unlock, err := lockFile(*path + ".lock")
	if err != nil {
		return err
	}
	defer unlock()
	ms, err := loadMembers(*path)
	if errors.Is(err, os.ErrNotExist) {
		ms, err = nil, nil
	}
	if err != nil {
		return err
	}
	if findMember(ms, name) >= 0 {
		return fmt.Errorf("%s is already a member (revoke first to issue a new key)", name)
	}
	var seed [32]byte
	if _, err := rand.Read(seed[:]); err != nil {
		return err
	}
	pub := hub.MemberPub(seed)
	ms = append(ms, member{Name: name, Key: base64.RawURLEncoding.EncodeToString(pub[:]), Hosts: *hosts, Added: time.Now().UTC().Format("2006-01-02")})
	if err := saveMembers(*path, ms); err != nil {
		return err
	}
	fmt.Fprintf(errOut, "Access key for %s (up to %d computers at once). It is shown only this once: send it privately; they enter it in the Remote tab.\n", name, *hosts)
	fmt.Fprintln(out, codePrefix+base64.RawURLEncoding.EncodeToString(seed[:]))
	return nil
}

func revoke(args []string, out, errOut io.Writer) error {
	fs, path := adminFlags("revoke", errOut)
	rest, err := parseAdmin(fs, path, args, 1, "revoke -members FILE NAME")
	if err != nil {
		return err
	}
	// read, change and write under the lock: two subcommands at once cannot undo each other's change
	unlock, err := lockFile(*path + ".lock")
	if err != nil {
		return err
	}
	defer unlock()
	ms, err := loadMembers(*path)
	if err != nil {
		return err
	}
	i := findMember(ms, rest[0])
	if i < 0 {
		return fmt.Errorf("%s is not a member", rest[0])
	}
	if err := saveMembers(*path, append(ms[:i:i], ms[i+1:]...)); err != nil {
		return err
	}
	fmt.Fprintf(out, "revoked %s; a running relay drops their computers within seconds\n", rest[0])
	return nil
}

func limit(args []string, out, errOut io.Writer) error {
	fs, path := adminFlags("limit", errOut)
	rest, err := parseAdmin(fs, path, args, 2, "limit -members FILE NAME N")
	if err != nil {
		return err
	}
	var n int
	if _, err := fmt.Sscanf(rest[1], "%d", &n); err != nil || n < 1 || fmt.Sprint(n) != rest[1] {
		return errors.New("N must be a whole number, at least 1")
	}
	// read, change and write under the lock: two subcommands at once cannot undo each other's change
	unlock, err := lockFile(*path + ".lock")
	if err != nil {
		return err
	}
	defer unlock()
	ms, err := loadMembers(*path)
	if err != nil {
		return err
	}
	i := findMember(ms, rest[0])
	if i < 0 {
		return fmt.Errorf("%s is not a member", rest[0])
	}
	ms[i].Hosts = n
	if err := saveMembers(*path, ms); err != nil {
		return err
	}
	fmt.Fprintf(out, "%s: up to %d computers at once\n", rest[0], n)
	return nil
}

func listMembers(args []string, out, errOut io.Writer) error {
	fs, path := adminFlags("members", errOut)
	if _, err := parseAdmin(fs, path, args, 0, "members -members FILE"); err != nil {
		return err
	}
	ms, err := loadMembers(*path)
	if err != nil {
		return err
	}
	for _, m := range ms {
		fmt.Fprintf(out, "%-20s %d hosts  added %s\n", m.Name, m.Hosts, m.Added)
	}
	return nil
}
