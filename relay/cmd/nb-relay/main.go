// Command nb-relay is the Nota Bene remote-control relay: a stateless
// WebSocket hub between hosts and devices. See PROTOCOL.md.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/acme"
	"golang.org/x/crypto/acme/autocert"

	"github.com/iCubeDm/nota-bene-ide/relay/hub"
)

// shutdownGrace bounds the whole shutdown; a variable so a test can shorten it.
var shutdownGrace = 5 * time.Second

// membersEvery is how often the members file is checked for changes.
var membersEvery = 2 * time.Second

func main() {
	os.Exit(exitCode(run(os.Args[1:], nil)))
}

// exitCode maps run's result to the process status; -h is not a failure (the
// flag package has already printed the usage).
func exitCode(err error) int {
	switch {
	case err == nil, errors.Is(err, flag.ErrHelp):
		return 0
	default:
		fmt.Fprintln(os.Stderr, "nb-relay:", err)
		return 1
	}
}

// run serves until SIGINT or SIGTERM. ready, when not nil, is told the address
// of the main listener once it accepts connections.
func run(args []string, ready func(addr string)) error {
	if len(args) > 0 {
		if cmd, ok := adminCommands[args[0]]; ok {
			return cmd(args[1:], os.Stdout, os.Stderr)
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runCtx(ctx, args, ready)
}

func runCtx(ctx context.Context, args []string, ready func(addr string)) error {
	fs := flag.NewFlagSet("nb-relay", flag.ContinueOnError)
	domain := fs.String("domain", "", "public host name to serve over TLS (required unless -listen)")
	cache := fs.String("cache", "/var/lib/nb-relay/autocert", "directory for the certificate cache")
	email := fs.String("email", "", "optional ACME contact address")
	httpsAddr := fs.String("https", ":443", "TLS listen address")
	httpAddr := fs.String("http", ":80", "ACME challenge and https redirect listen address")
	listen := fs.String("listen", "", "plain HTTP on a loopback address, for tests and local runs")
	maxHosts := fs.Int("max-hosts", hub.DefaultOptions().MaxHosts, "most hosts connected at once (0 = unlimited)")
	membersPath := fs.String("members", "", "admit only hosts signed by a member key in this file (see nb-relay invite); without it the relay is open")
	maxDevices := fs.Int("max-devices", hub.DefaultOptions().MaxDevicesPerHost, "most devices per host (0 = unlimited)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *listen == "" && *domain == "" {
		return errors.New("-domain is required unless -listen is given")
	}
	if *listen != "" {
		if err := checkLoopback(*listen); err != nil {
			return err
		}
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	o := hub.DefaultOptions()
	o.MaxHosts, o.MaxDevicesPerHost, o.Log = *maxHosts, *maxDevices, logger
	var members *memberList
	if *membersPath != "" {
		ms, err := loadMembers(*membersPath)
		if err != nil {
			return err
		}
		members = newMemberList(ms)
		o.Admit = members.admit
	}
	srv := hub.NewServer(o)
	if members != nil {
		go watchMembers(ctx, *membersPath, members, srv, membersEvery, logger)
	}
	handler := srv.Handler()

	var servers []*http.Server
	errc := make(chan error, 2)
	serve := func(srv *http.Server, ln net.Listener, tlsOn bool) {
		servers = append(servers, srv)
		go func() {
			var err error
			if tlsOn {
				err = srv.ServeTLS(ln, "", "")
			} else {
				err = srv.Serve(ln)
			}
			if !errors.Is(err, http.ErrServerClosed) {
				errc <- err
			}
		}()
	}

	var mainAddr string
	if *listen != "" {
		ln, err := net.Listen("tcp", *listen)
		if err != nil {
			return err
		}
		mainAddr = ln.Addr().String()
		serve(newServer(handler), ln, false)
	} else {
		m := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(*domain),
			Cache:      autocert.DirCache(*cache),
			Email:      *email,
		}
		tcfg := m.TLSConfig()
		// WebSocket upgrades need HTTP/1.1; keep h2 out of the negotiation.
		tcfg.NextProtos = []string{"http/1.1", acme.ALPNProto}
		tcfg.MinVersion = tls.VersionTLS12
		sln, err := net.Listen("tcp", *httpsAddr)
		if err != nil {
			return err
		}
		hln, err := net.Listen("tcp", *httpAddr)
		if err != nil {
			sln.Close()
			return err
		}
		mainAddr = sln.Addr().String()
		ts := newServer(handler)
		ts.TLSConfig = tcfg
		ts.TLSNextProto = map[string]func(*http.Server, *tls.Conn, http.Handler){}
		serve(ts, sln, true)
		serve(newServer(m.HTTPHandler(nil)), hln, false)
	}

	logger.Info("start")
	if ready != nil {
		ready(mainAddr)
	}

	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-tick.C:
			hosts, devices := srv.Stats()
			logger.Info("connections", "hosts", hosts, "devices", devices, "closes", formatCloses(srv.TakeCloses()))
		case err := <-errc:
			stopAll(srv, servers)
			return err
		case <-ctx.Done():
			err := stopAll(srv, servers)
			logger.Info("stop")
			return err
		}
	}
}

// stopAll closes the hub and shuts the servers down, all within shutdownGrace.
// The hub goes first: hijacked WebSocket connections are not tracked by
// http.Server.Shutdown. A peer that never completes its close handshake cannot
// hold the process past the deadline.
func stopAll(h *hub.Server, servers []*http.Server) error {
	sctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	closed := make(chan struct{})
	go func() { h.Close(); close(closed) }()
	select {
	case <-closed:
	case <-sctx.Done():
	}
	var first error
	for _, srv := range servers {
		if err := srv.Shutdown(sctx); err != nil {
			srv.Close()
			if first == nil {
				first = err
			}
		}
	}
	return first
}

// formatCloses renders the minute's relay-initiated closes as
// "device/4408=2 host/4409=1", sorted; "-" when there were none.
func formatCloses(c map[hub.CloseKey]int) string {
	if len(c) == 0 {
		return "-"
	}
	parts := make([]string, 0, len(c))
	for k, n := range c {
		parts = append(parts, fmt.Sprintf("%s/%d=%d", k.Role, k.Code, n))
	}
	sort.Strings(parts)
	return strings.Join(parts, " ")
}

func newServer(h http.Handler) *http.Server {
	return &http.Server{
		Handler: h,
		// ReadTimeout also bounds a stalled TLS handshake; hijacking a
		// WebSocket clears the deadlines, so it does not limit connections.
		ReadTimeout:       30 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		// net/http would log client addresses ("TLS handshake error from ...").
		ErrorLog: log.New(io.Discard, "", 0),
	}
}

// checkLoopback refuses a -listen address that is not on the loopback
// interface: plain HTTP must never face the network.
func checkLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("-listen %q: %w", addr, err)
	}
	if host == "localhost" {
		return nil
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return nil
	}
	return fmt.Errorf("-listen %q is not a loopback address (127.0.0.0/8, ::1, localhost)", addr)
}
