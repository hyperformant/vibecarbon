#!/usr/bin/env bash
# Wait until the cert-manager controller is SETTLED before the TLS Certificate
# is applied: its Deployment rollout is complete, and its leader lease
# (kube-system/cert-manager-controller, the v1.20 default) is held by a pod of
# the Deployment's current ReplicaSet. A controller handoff while the
# Certificate lands can miss the Secret it should reuse in the new leader's
# cache and issue a brand-new certificate.
#
# The GitOps deploy workflow's form of the CLI's wait (src/lib/deploy/k8s/
# readiness.js awaitCertManagerLeader, which judges the same three objects the
# same way). One bounded wait: CERT_MANAGER_LEADER_BUDGET_S seconds (default
# 180) for the rollout and the lease together, then a clear error.
#
# Usage: bash scripts/await-cert-manager-leader.sh   (KUBECONFIG set)
set -u

budget="${CERT_MANAGER_LEADER_BUDGET_S:-180}"
poll="${CERT_MANAGER_LEADER_POLL_S:-2}"
lease_ns=kube-system
lease_name=cert-manager-controller
revision_path='{.metadata.annotations.deployment\.kubernetes\.io/revision}'
deadline=$(($(date +%s) + budget))

fail() {
  echo "::error::The cert-manager controller did not settle as leader within ${budget}s: $1. The TLS Certificate was not applied. Look at kubectl -n cert-manager get pods and kubectl -n ${lease_ns} get lease ${lease_name} -o yaml, then re-run this workflow"
  exit 1
}

if ! kubectl -n cert-manager rollout status deployment/cert-manager --timeout="${budget}s"; then
  fail "the cert-manager rollout did not complete"
fi

reason="no reading recorded"
while :; do
  if ! revision=$(kubectl -n cert-manager get deployment cert-manager -o "jsonpath=${revision_path}" 2>&1); then
    reason="could not read deployment cert-manager/cert-manager (${revision%%$'\n'*})"
  elif ! sets=$(kubectl -n cert-manager get replicasets \
    -l app.kubernetes.io/instance=cert-manager,app.kubernetes.io/component=controller \
    -o "jsonpath={range .items[*]}{.metadata.name}{\" \"}${revision_path}{\"\\n\"}{end}" 2>&1); then
    reason="could not read the cert-manager ReplicaSets (${sets%%$'\n'*})"
  elif ! holder=$(kubectl -n "$lease_ns" get lease "$lease_name" -o 'jsonpath={.spec.holderIdentity}' 2>&1); then
    reason="could not read lease ${lease_ns}/${lease_name} (${holder%%$'\n'*})"
  else
    current=$(printf '%s\n' "$sets" | awk -v rev="$revision" '$2 == rev && rev != "" { print $1; exit }')
    if [ -z "$current" ]; then
      reason="no ReplicaSet of the cert-manager Deployment carries its revision ${revision:-?} yet"
    elif [ -z "$holder" ]; then
      reason="the lease ${lease_ns}/${lease_name} has no holder yet"
    else
      case "$holder" in
        "$current"-*)
          echo "cert-manager leader settled: ${lease_ns}/${lease_name} is held by ${holder}"
          exit 0
          ;;
      esac
      reason="the lease ${lease_ns}/${lease_name} is held by ${holder}, not by a pod of the current ReplicaSet ${current}"
    fi
  fi
  [ "$(date +%s)" -ge "$deadline" ] && fail "$reason"
  sleep "$poll"
done
