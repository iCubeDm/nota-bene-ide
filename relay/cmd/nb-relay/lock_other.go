//go:build !unix

package main

// lockFile is a no-op where flock is missing: the relay is deployed on Linux.
func lockFile(string) (func(), error) { return func() {}, nil }
