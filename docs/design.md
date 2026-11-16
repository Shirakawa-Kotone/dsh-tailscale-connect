# Design notes

This document records the non-obvious design choices behind `dsh-tailscale-connect`. It deliberately omits environment-specific values.

## Goals

- Make the DSH Web GUI reachable from devices on a Tailscale tailnet without exposing the LAN.
- Keep the phone remote-control surface (`@linxin666/dsh-remote-bridge`'s `/ios/v1` WebSocket and pairing QR) usable over the tailnet.
- Require no Cloudflare tunnel, relay service, TLS certificate, or change to the DSH core.

## Ingress modes

**`proxy` (default).** The plugin keeps the DSH web server on its default loopback bind and opens a second listener on one concrete Tailscale IPv4 address. HTTP requests and WebSocket upgrades are forwarded to `127.0.0.1:<DSH port>`.

Why not bind DSH itself to the tailnet address: `@deepseek-ai/dsh-host-webserver` accepts exactly one concrete bind address, so moving it off loopback would take the desktop browser and the CLI's own startup URL away. A second listener leaves loopback untouched.

Why not `0.0.0.0`: the web server rejects wildcard binds in DSH 0.2.x (it would expose the GUI on every interface). The proxy binds only the Tailscale address and re-checks the source address at the socket layer.

**`serve`.** The plugin keeps the loopback bind and configures `tailscale serve` to publish it. This mode is useful when the operator wants the MagicDNS name without a port suffix, an `https://`/`wss://` URL for clients with strict transport security, or already owns a Serve route.

Serve configuration is read and classified before it is written: a route that already points at this DSH port is adopted, a stale loopback route is replaced, and a route owned by another service is refused unless `overwriteServe: true` is set. On shutdown only the port this plugin claimed is removed (`tailscale serve --http=<port> off`), never a global reset.

## The `/api` Host fence

`@deepseek-ai/dsh-client-connection` rejects every `/api` request whose `Host` is neither loopback, the listener's bind address, nor a configured `trustedHosts` authority. `tailscale serve` preserves the client's `Host`, and the proxy does the same, so a tailnet browser must have its authority accepted.

`trustedHosts` belongs to the `connection` row, not to `web-runtime` (whose config schema has no such key). The plugin injects the remote-facing `host:port` values into `connection.trustedHosts` at runtime; the fence reads that array on every request, so no profile patch or restart is needed. Access still requires the DSH process token exchanged for a signed cookie — trusting the host does not authenticate a caller.

## Pairing origin

`@linxin666/dsh-remote-bridge` resolves the origin a phone should dial in this order: its own live relay/tunnel, `DSH_REMOTE_PUBLIC_BASE_URL`, then the LAN forwarder. A loopback-bound host has neither a relay nor a LAN forwarder, so the plugin publishes the tailnet origin in that environment variable. It keeps only the URL origin, so a non-root Serve path cannot be published.

The pairing-token route stays loopback-only: a tailnet client can dial `/ios/v1` with an already-issued ticket, but cannot mint one.

## Fixed short link

The DSH launch token changes with every process, so the tokenized startup URL cannot be bookmarked. The plugin accepts a stable code at `/t/<code>` and redirects to `connection.authenticatedUrl(<public base>)`; DSH then mints its normal cookie and redirects to the clean URL.

The code is generated once and persisted in `$DSH_HOME/tailscale-access.json` with mode `0600`. It is a bearer credential with the same power as the process token, so:

- the status endpoint never returns it;
- wrong codes get a 404 and per-client 429s after repeated failures;
- redirect origins come from an allowlist; a forged `Host` falls back to the advertised origin instead of leaking the token elsewhere.

## Testing

`node --test test/` covers discovery, URL planning, Serve classification and teardown, HTTP/WebSocket forwarding, pairing publication, access-code persistence/rotation, and short-link redirect/error behaviour. Network tests use loopback servers and temporary directories; nothing depends on a real tailnet.
