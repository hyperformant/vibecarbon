# CANDIDATE-FIX shape (MODE=combined): ONE ACME order covering apex + wildcard
# via explicit tls.domains — a single lego order presents both TXT values in
# one present/validate/cleanup cycle, so there is no second concurrent order
# to clobber the shared _acme-challenge.ISODOMAIN name (the 2026-08-30 vultr
# compose-ha RCA: the split store-wildcard + router-apex design races itself
# on providers whose zone holds one value per name).
http:
  routers:
    iso:
      rule: Host(`ISODOMAIN`)
      entryPoints: [websecure]
      service: noop@internal
      tls:
        certResolver: letsencrypt
        domains:
          - main: "ISODOMAIN"
            sans: ["*.ISODOMAIN"]
