# kube-prometheus-stack (Pulumi)

Deploys the Prometheus Operator stack via the `prometheus-community/kube-prometheus-stack` Helm chart.

- Namespace: `kube-prometheus-stack`
- Chart version: `KUBE_PROMETHEUS_STACK_VERSION` (from `versions.yml` via Taskfile)
- Ingress: Cloudflare ingress controller (class from `ingressClassName`)
- Persistence: Prometheus 200Gi, Grafana 10Gi, Alertmanager 10Gi (overridable)
- Retention: unlimited time-based (`retention: 0d`)
- Grafana dashboards: drop `*.json` into `pulumi/stacks/kube-prometheus-stack/dashboards/` and re-deploy

Secrets via 1Password `.env`:
- `GRAFANA_ADMIN_USER`
- `GRAFANA_ADMIN_PASSWORD`
- (Optional) `INGRESS_CLASS_NAME`, `GRAFANA_HOST`, `ALERTMANAGER_HOST`
