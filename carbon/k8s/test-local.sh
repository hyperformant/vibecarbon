#!/bin/bash
# Local Kubernetes Testing with k3d
# Tests the k8s manifests locally before deploying to production

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

CLUSTER_NAME="vibecarbon-local"
NAMESPACE="vibecarbon"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

print_step() { echo -e "\n${GREEN}▶ $1${NC}"; }
print_info() { echo -e "${BLUE}ℹ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠ $1${NC}"; }
print_error() { echo -e "${RED}✗ $1${NC}"; }
print_success() { echo -e "${GREEN}✓ $1${NC}"; }

check_dependencies() {
    print_step "Checking dependencies..."

    local missing=()

    command -v docker &> /dev/null || missing+=("docker")
    command -v kubectl &> /dev/null || missing+=("kubectl")
    command -v k3d &> /dev/null || missing+=("k3d")

    if [ ${#missing[@]} -ne 0 ]; then
        print_error "Missing dependencies: ${missing[*]}"
        echo ""
        echo "Install instructions:"
        echo ""
        if [[ " ${missing[*]} " =~ " kubectl " ]]; then
            echo "  kubectl:"
            echo "    curl -LO \"https://dl.k8s.io/release/\$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl\""
            echo "    sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl"
            echo ""
        fi
        if [[ " ${missing[*]} " =~ " k3d " ]]; then
            echo "  k3d:"
            echo "    curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash"
            echo ""
        fi
        exit 1
    fi

    print_success "All dependencies satisfied"
}

create_cluster() {
    print_step "Creating k3d cluster: ${CLUSTER_NAME}"

    # Check if cluster exists
    if k3d cluster list | grep -q "${CLUSTER_NAME}"; then
        print_warning "Cluster ${CLUSTER_NAME} already exists"
        read -p "Delete and recreate? (y/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            k3d cluster delete ${CLUSTER_NAME}
        else
            print_info "Using existing cluster"
            return
        fi
    fi

    # Create cluster with port mappings
    # - 8080:80 for HTTP traffic via Traefik
    # - 8443:443 for HTTPS traffic
    # Note: k3d comes with built-in Traefik, but we deploy our own
    k3d cluster create ${CLUSTER_NAME} \
        --port "8080:80@loadbalancer" \
        --port "8443:443@loadbalancer" \
        --agents 1 \
        --k3s-arg "--disable=traefik@server:0" \
        --wait

    print_success "Cluster created"
}

install_traefik_crds() {
    print_step "Installing Traefik CRDs..."

    # Install Traefik CRDs from the official Traefik helm chart
    # These are needed for IngressRoute and Middleware resources
    kubectl apply -f https://raw.githubusercontent.com/traefik/traefik/v3.2/docs/content/reference/dynamic-configuration/kubernetes-crd-definition-v1.yml 2>/dev/null || {
        print_warning "Could not fetch Traefik v3 CRDs, trying v2..."
        kubectl apply -f https://raw.githubusercontent.com/traefik/traefik/v2.11/docs/content/reference/dynamic-configuration/kubernetes-crd-definition-v1.yml
    }

    print_success "Traefik CRDs installed"
}

deploy_manifests() {
    print_step "Deploying Kubernetes manifests..."

    # Install Traefik CRDs first (since we disabled k3d's built-in Traefik)
    install_traefik_crds

    # Use the local overlay which:
    # - Sets correct namespace (vibecarbon)
    # - Uses local-path storage class instead of hcloud-volumes
    # - Uses nginx placeholder for app image
    # - Includes secrets and configmap
    # - Reduces replicas for local testing

    print_info "Applying local overlay..."

    # Apply the local overlay with kustomize
    # Use kustomize build with load restrictor to allow referencing base manifests
    kubectl kustomize "${SCRIPT_DIR}/overlays/local" --load-restrictor=LoadRestrictionsNone | kubectl apply -f -

    print_success "Manifests deployed"
}

wait_for_pods() {
    print_step "Waiting for pods to be ready..."

    local timeout=300
    local start_time=$(date +%s)

    # First, wait for any pods to appear
    print_info "Waiting for pods to be created..."
    local pod_count=0
    while [ $pod_count -eq 0 ]; do
        local current_time=$(date +%s)
        local elapsed=$((current_time - start_time))

        if [ $elapsed -gt 60 ]; then
            print_warning "No pods created after 60s, checking all namespaces..."
            kubectl get pods -A
            break
        fi

        pod_count=$(kubectl get pods -n ${NAMESPACE} --no-headers 2>/dev/null | wc -l)
        if [ $pod_count -eq 0 ]; then
            sleep 2
        fi
    done

    # Now wait for pods to be ready
    while true; do
        local current_time=$(date +%s)
        local elapsed=$((current_time - start_time))

        if [ $elapsed -gt $timeout ]; then
            print_error "Timeout waiting for pods"
            echo ""
            echo "Pod Status:"
            kubectl get pods -n ${NAMESPACE} -o wide
            echo ""
            echo "Events:"
            kubectl get events -n ${NAMESPACE} --sort-by='.lastTimestamp' | tail -20
            exit 1
        fi

        local total=$(kubectl get pods -n ${NAMESPACE} --no-headers 2>/dev/null | wc -l)
        local running=$(kubectl get pods -n ${NAMESPACE} --no-headers 2>/dev/null | grep "Running" | wc -l)
        local pending=$(kubectl get pods -n ${NAMESPACE} --no-headers 2>/dev/null | grep -E "Pending|ContainerCreating|Init" | wc -l)
        local failed=$(kubectl get pods -n ${NAMESPACE} --no-headers 2>/dev/null | grep -E "Error|CrashLoopBackOff|ImagePullBackOff|CreateContainerConfigError" | wc -l)

        if [ "$total" -gt 0 ] && [ "$running" -eq "$total" ]; then
            print_success "All ${total} pods ready"
            break
        fi

        if [ "$failed" -gt 0 ]; then
            print_warning "${failed} pods have errors (will continue waiting...)"
        fi

        print_info "Pods: ${running}/${total} running, ${pending} pending (${elapsed}s)"
        sleep 5
    done
}

show_status() {
    print_step "Deployment Status"

    echo ""
    echo "Pods:"
    kubectl get pods -n ${NAMESPACE} -o wide 2>/dev/null || echo "No pods found"

    echo ""
    echo "Services:"
    kubectl get svc -n ${NAMESPACE} 2>/dev/null || echo "No services found"

    echo ""
    echo "PVCs:"
    kubectl get pvc -n ${NAMESPACE} 2>/dev/null || echo "No PVCs found"
}

show_access_info() {
    print_step "Access Information"

    echo ""
    echo -e "${BLUE}Local URLs (no auth required):${NC}"
    echo "  App:       http://localhost:8080"
    echo "  Studio:    http://studio.localhost:8080"
    echo "  n8n:       http://n8n.localhost:8080  (admin / local-n8n-password)"
    echo "  Traefik:   http://traefik.localhost:8080"
    echo ""
    echo -e "${BLUE}Admin URLs (requires admin role - production-like):${NC}"
    echo "  Studio:    http://localhost:8080/admin/studio"
    echo "  n8n:       http://localhost:8080/admin/n8n"
    echo ""
    echo -e "${BLUE}Supabase API (via Kong):${NC}"
    echo "  Auth:      http://localhost:8080/auth/v1/"
    echo "  REST:      http://localhost:8080/rest/v1/"
    echo "  Realtime:  http://localhost:8080/realtime/v1/"
    echo "  Storage:   http://localhost:8080/storage/v1/"
    echo ""
    echo -e "${BLUE}App API:${NC}"
    echo "  Health:    http://localhost:8080/api/health"
    echo "  Docs:      http://localhost:8080/api/docs"
    echo "  v1 API:    http://localhost:8080/api/v1/..."
    echo ""
    echo -e "${BLUE}Port Forwarding (direct service access):${NC}"
    echo "  kubectl port-forward svc/postgres 5432:5432 -n ${NAMESPACE}"
    echo "  kubectl port-forward svc/kong 8000:8000 -n ${NAMESPACE}"
    echo "  kubectl port-forward svc/studio 3001:3000 -n ${NAMESPACE}"
    echo ""
    echo -e "${BLUE}View logs:${NC}"
    echo "  kubectl logs -f statefulset/postgres -n ${NAMESPACE}"
    echo "  kubectl logs -f deployment/kong -n ${NAMESPACE}"
    echo "  kubectl logs -f deployment/auth -n ${NAMESPACE}"
    echo "  kubectl logs -f deployment/app -n ${NAMESPACE}"
    echo ""
    echo -e "${BLUE}Delete cluster when done:${NC}"
    echo "  k3d cluster delete ${CLUSTER_NAME}"
    echo "  # or: npm run k8s:local:down"
    echo ""
}

debug_pods() {
    print_step "Debugging pod issues..."

    echo ""
    echo "Failed/Pending pods:"
    kubectl get pods -n ${NAMESPACE} --no-headers 2>/dev/null | grep -v "Running" || echo "All pods running"

    echo ""
    echo "Recent events:"
    kubectl get events -n ${NAMESPACE} --sort-by='.lastTimestamp' 2>/dev/null | tail -15

    local problem_pod=$(kubectl get pods -n ${NAMESPACE} --no-headers 2>/dev/null | grep -v "Running" | head -1 | awk '{print $1}')
    if [ -n "$problem_pod" ]; then
        echo ""
        echo "Details for problematic pod: $problem_pod"
        kubectl describe pod "$problem_pod" -n ${NAMESPACE} 2>/dev/null | tail -30
    fi
}

cleanup() {
    print_step "Cleaning up local cluster..."
    k3d cluster delete ${CLUSTER_NAME}

    # Also delete k3d docker volumes to ensure fresh state
    docker volume rm k3d-${CLUSTER_NAME}-images 2>/dev/null || true

    print_success "Cluster deleted"
}

# Parse arguments
case "${1:-}" in
    "delete"|"cleanup"|"down")
        cleanup
        exit 0
        ;;
    "status")
        kubectl config use-context k3d-${CLUSTER_NAME} 2>/dev/null || true
        show_status
        exit 0
        ;;
    "logs")
        kubectl config use-context k3d-${CLUSTER_NAME} 2>/dev/null || true
        kubectl logs -f "${2:-deployment/app}" -n ${NAMESPACE}
        exit 0
        ;;
    "debug")
        kubectl config use-context k3d-${CLUSTER_NAME} 2>/dev/null || true
        debug_pods
        exit 0
        ;;
    "help"|"-h"|"--help")
        echo "Usage: $0 [command]"
        echo ""
        echo "Commands:"
        echo "  (none)     Create cluster and deploy"
        echo "  status     Show pod/service status"
        echo "  logs       Follow logs (default: deployment/app)"
        echo "  debug      Debug failing pods"
        echo "  delete     Delete the local cluster"
        echo "  help       Show this help"
        exit 0
        ;;
esac

# Main flow
echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════════╗"
echo "║         Vibecarbon Local Kubernetes Testing                ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

check_dependencies
create_cluster
deploy_manifests
wait_for_pods
show_status
show_access_info

print_success "Local k8s environment ready!"
