# Apex router with certresolver — mirrors the app router's apex cert request.
http:
  routers:
    iso:
      rule: Host(`ISODOMAIN`)
      entryPoints: [websecure]
      service: noop@internal
      tls:
        certResolver: letsencrypt
