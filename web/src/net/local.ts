/**
 * Whether this page is on the computer the window runs on (issue 461): the server listens on loopback only, so a page
 * reached any other way (a relay, a tunnel) is on another machine. Show in Finder and Open are offered only here; the
 * server refuses them for anything but this machine's page anyway (server/src/osFiles.ts).
 */
export const isLocalPage = (host: string = location.hostname): boolean => host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
