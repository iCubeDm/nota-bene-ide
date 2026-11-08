// Command nb-relay is the Nota Bene remote-control relay: a stateless
// WebSocket hub between hosts and devices. See PROTOCOL.md.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"golang.org/x/crypto/acme"
	"golang.org/x/crypto/acme/autocert"

	"github.com/iCubeDm/nota-bene-ide/relay/internal/relay"
)

const shutdownGrace = 5 * time.Second

func main() {
	if err := run(os.Args[1:], nil); err != nil {
		fmt.Fprintln(os.Stderr, "nb-relay:", err)
		os.Exit(1)
	}
}

// run serves until SIGINT or SIGTERM. ready, when not nil, is told the address
// of the main listener once it accepts connections.
func run(args []string, ready func(addr string)) error {
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
	maxHosts := fs.Int("max-hosts", relay.DefaultOptions().MaxHosts, "most hosts connected at once (0 = unlimited)")
	maxDevices := fs.Int("max-devices", relay.DefaultOptions().MaxDevicesPerHost, "most devices per host (0 = unlimited)")
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

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	o := relay.DefaultOptions()
	o.MaxHosts, o.MaxDevicesPerHost, o.Log = *maxHosts, *maxDevices, log
	hub := relay.NewServer(o)
	defer hub.Close()
	handler := hub.Handler()

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

	log.Info("start")
	if ready != nil {
		ready(mainAddr)
	}

	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-tick.C:
			hosts, devices := hub.Stats()
			log.Info("connections", "hosts", hosts, "devices", devices)
		case err := <-errc:
			hub.Close()
			return err
		case <-ctx.Done():
			// Close the hub first: hijacked WebSocket connections are not
			// tracked by http.Server.Shutdown.
			hub.Close()
			sctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
			defer cancel()
			var first error
			for _, srv := range servers {
				if err := srv.Shutdown(sctx); err != nil && first == nil {
					first = err
				}
			}
			log.Info("stop")
			return first
		}
	}
}

func newServer(h http.Handler) *http.Server {
	return &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
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
