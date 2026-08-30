# Mirror of renderTraefikDefaultCert's DNS-01 output for the iso domain:
# wildcard default-store cert. The apex is requested via the router below.
tls:
  stores:
    default:
      defaultGeneratedCert:
        resolver: letsencrypt
        domain:
          main: "*.ISODOMAIN"
