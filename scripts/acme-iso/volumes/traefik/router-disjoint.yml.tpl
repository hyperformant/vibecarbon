# CANDIDATE-FIX shape (MODE=disjoint): drop the wildcard entirely — the apex
# and each subdomain get their OWN cert via certResolver, so every ACME order
# validates at a DIFFERENT _acme-challenge name. Immune to providers that
# cannot serve multiple/rapidly-changed TXT values at one name (the proven
# Vultr zone-build behavior, 2026-08-30 probes).
http:
  routers:
    iso:
      rule: Host(`ISODOMAIN`)
      entryPoints: [websecure]
      service: noop@internal
      tls:
        certResolver: letsencrypt
    iso-sub:
      rule: Host(`studio.ISODOMAIN`)
      entryPoints: [websecure]
      service: noop@internal
      tls:
        certResolver: letsencrypt
