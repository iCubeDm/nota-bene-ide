package main

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/curve25519"

	"github.com/iCubeDm/nota-bene-ide/relay/internal/relay"
)

var base64URL = base64.RawURLEncoding

func TestListenRefusesNonLoopback(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:0", ":0", "192.0.2.1:0", "[::]:0", "relay.example.com:0"} {
		err := run([]string{"-listen", addr}, nil)
		if err == nil || !strings.Contains(err.Error(), "loopback") {
			t.Errorf("-listen %s: err = %v, want one naming loopback", addr, err)
		}
	}
}

func TestDomainRequiredWithoutListen(t *testing.T) {
	err := run(nil, nil)
	if err == nil || !strings.Contains(err.Error(), "-domain") {
		t.Fatalf("err = %v, want one naming -domain", err)
	}
}

func TestHealthz(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	addrc := make(chan string, 1)
	done := make(chan error, 1)
	go func() { done <- runCtx(ctx, []string{"-listen", "127.0.0.1:0"}, func(a string) { addrc <- a }) }()
	var addr string
	select {
	case addr = <-addrc:
	case err := <-done:
		t.Fatalf("run ended early: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("not ready")
	}
	resp, err := http.Get("http://" + addr + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "ok" {
		t.Fatalf("healthz = %d %q", resp.StatusCode, body)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("shutdown: %v", err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("no shutdown within 5 s")
	}
}

// The expected values were computed outside Go (pure-Python X25519 checked
// against the RFC 7748 vector, hashlib, hmac), not with relay.Proof, so a
// change of label, role string or byte order fails here. PROTOCOL.md must show
// the same values.
const (
	exDevicePriv  = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA"
	exHostPriv    = "ISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A"
	exEphPub      = "ZLEBsdC-WocEvQePmJUAH8A-jp-VIvGI3RKNmEbUhGY"
	exNonce       = "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1-f4A"
	exDevicePub   = "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw"
	exDeviceHash  = "qqj_9wO1CyKX9PbhNQj3JCDZb9Aeu4TLB0RJyq72QEE"
	exHostID      = "WGmv9FBUlzLLqu1eXfmzCm2jHLDldCutWtShp2jxpns"
	exDeviceProof = "X2BJlpgFEN2Z9t7I2JL_d3lZgo0FRsi2nCTG5pOa6II"
	exHostProof   = "n7FU6_HfPhaPqmnxzofDb73cYRnRzvWyX6abvpdp3wQ"
)

func TestProtocolExample(t *testing.T) {
	dec := func(s string) (k [32]byte) {
		b, err := base64URL.DecodeString(s)
		if err != nil || len(b) != 32 {
			t.Fatalf("bad example value %q", s)
		}
		copy(k[:], b)
		return
	}
	devPriv, hostPriv, eph, nonce := dec(exDevicePriv), dec(exHostPriv), dec(exEphPub), dec(exNonce)
	pub := func(priv [32]byte) [32]byte {
		p, err := curve25519.X25519(priv[:], curve25519.Basepoint)
		if err != nil {
			t.Fatal(err)
		}
		return [32]byte(p)
	}
	check := func(name, got, want string) {
		t.Helper()
		if got != want {
			t.Errorf("%s = %s, want %s", name, got, want)
		}
	}
	devPub, hostPub := pub(devPriv), pub(hostPriv)
	check("device public key", base64URL.EncodeToString(devPub[:]), exDevicePub)
	check("device hash", relay.DeviceHash(devPub), exDeviceHash)
	check("host id", relay.HostID(hostPub), exHostID)
	check("device proof", base64URL.EncodeToString(relay.Proof("device", devPriv, eph, nonce)), exDeviceProof)
	check("host proof", base64URL.EncodeToString(relay.Proof("host", hostPriv, eph, nonce)), exHostProof)

	doc, err := os.ReadFile("../../PROTOCOL.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{exDevicePriv, exHostPriv, exEphPub, exNonce, exDevicePub, exDeviceHash, exHostID, exDeviceProof, exHostProof} {
		if !strings.Contains(string(doc), v) {
			t.Errorf("PROTOCOL.md does not contain %s", v)
		}
	}
}
