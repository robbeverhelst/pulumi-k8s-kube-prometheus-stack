import { ConfigMap, Namespace } from '@pulumi/kubernetes/core/v1'
import { Release } from '@pulumi/kubernetes/helm/v3'
import { Config, interpolate, secret } from '@pulumi/pulumi'

const cfg = new Config()

// Configurable settings with env-first fallback
const namespaceName = cfg.get('namespace') ?? 'kube-prometheus-stack'
const helmChartVersion = process.env.KUBE_PROMETHEUS_STACK_VERSION || cfg.get('helmChartVersion') || undefined
// Ingress configuration must be provided via Pulumi config (no defaults in code)
const _ingressClassName = cfg.require('ingressClassName')
const grafanaHost = cfg.require('grafanaHost')
const alertmanagerHost = cfg.require('alertmanagerHost')

const grafanaAdminUser = process.env.GRAFANA_ADMIN_USER
  ? process.env.GRAFANA_ADMIN_USER
  : cfg.get('grafanaAdminUser') || 'admin'
const grafanaAdminPassword = process.env.GRAFANA_ADMIN_PASSWORD
  ? secret(process.env.GRAFANA_ADMIN_PASSWORD)
  : cfg.requireSecret('grafanaAdminPassword')

// Optional Telegram alerting (free, mainstream)
const telegramBotToken = process.env.ALERTS_TELEGRAM_BOT_TOKEN || cfg.get('telegramBotToken') || ''
const telegramChatId = process.env.ALERTS_TELEGRAM_CHAT_ID || cfg.get('telegramChatId') || ''

// Debug logging
console.log('Telegram Bot Token present:', telegramBotToken ? 'YES' : 'NO')
console.log('Telegram Chat ID present:', telegramChatId ? 'YES' : 'NO')

// Storage
const storageClass = cfg.get('storageClass') || 'truenas-hdd-mirror-iscsi'
const prometheusStorageSize = cfg.get('prometheusStorageSize') || '200Gi'
const alertmanagerStorageSize = cfg.get('alertmanagerStorageSize') || '10Gi'
const grafanaStorageSize = cfg.get('grafanaStorageSize') || '10Gi'

// Namespace
const ns = new Namespace('kps-ns', { metadata: { name: namespaceName } })

// Cluster-wide selectors for ServiceMonitor/PodMonitor/Probe/Rules
const promSpecCommon: any = {
  serviceMonitorSelector: {},
  serviceMonitorSelectorNilUsesHelmValues: false,
  serviceMonitorNamespaceSelector: {},
  podMonitorSelector: {},
  podMonitorSelectorNilUsesHelmValues: false,
  podMonitorNamespaceSelector: {},
  probeSelector: {},
  probeSelectorNilUsesHelmValues: false,
  probeNamespaceSelector: {},
  ruleSelector: {},
  ruleNamespaceSelector: {},
  retention: '0d', // unlimited time-based retention (disk grows until PVC fills)
  enableAdminAPI: true,
}

// Tolerations to allow on control-plane nodes
const controlPlaneTolerations = [
  { key: 'node-role.kubernetes.io/master', effect: 'NoSchedule', operator: 'Exists' },
  { key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule', operator: 'Exists' },
]

// Helm Release (lets Helm manage CRDs and ordering)
const _release = new Release(
  'kube-prometheus-stack',
  {
    chart: 'kube-prometheus-stack',
    namespace: namespaceName,
    repositoryOpts: { repo: 'https://prometheus-community.github.io/helm-charts' },
    version: helmChartVersion,
    skipCrds: false,
    atomic: true,
    cleanupOnFail: true,
    waitForJobs: true,
    createNamespace: false,
    values: {
      cleanPrometheusOperatorObjectNames: true,

      prometheusOperator: {
        enabled: true,
        admissionWebhooks: { enabled: true },
      },

      // Expose Alertmanager
      alertmanager: {
        enabled: true,
        service: {
          type: 'LoadBalancer',
          port: 9093,
          targetPort: 9093,
        },
        persistence: {
          enabled: true,
          storageClassName: storageClass,
          size: alertmanagerStorageSize,
        },
        config:
          telegramBotToken && telegramChatId
            ? {
                global: {
                  resolve_timeout: '5m',
                },
                route: {
                  receiver: 'telegram',
                  group_by: ['alertname', 'cluster', 'service'],
                  group_wait: '10s',
                  group_interval: '10s',
                  repeat_interval: '1h',
                  routes: [
                    {
                      matchers: ['alertname = "Watchdog"'],
                      receiver: 'null',
                    },
                    {
                      matchers: ['alertname =~ "KubeProxy.*"'],
                      receiver: 'null',
                    },
                    {
                      matchers: ['alertname =~ "PrometheusOperator.*"'],
                      receiver: 'null',
                    },
                    {
                      matchers: ['alertname = "TargetDown", job = "kube-proxy"'],
                      receiver: 'null',
                    },
                    {
                      matchers: ['alertname = "PrometheusNotConnectedToAlertmanagers"'],
                      receiver: 'null',
                    },
                    {
                      matchers: ['alertname =~ "KubeAPI.*"'],
                      receiver: 'null',
                    },
                  ],
                },
                receivers: [
                  {
                    name: 'telegram',
                    telegram_configs: [
                      {
                        bot_token: telegramBotToken,
                        chat_id: parseInt(telegramChatId, 10),
                        send_resolved: true,
                        parse_mode: 'HTML',
                        message: `{{ range .Alerts }}
<b>🚨 {{ .Labels.alertname }}</b>
<b>Status:</b> {{ .Status }}
<b>Severity:</b> {{ .Labels.severity }}
<b>Summary:</b> {{ .Annotations.summary }}
<b>Description:</b> {{ .Annotations.description }}
{{ end }}`,
                      },
                    ],
                  },
                  {
                    name: 'null',
                  },
                ],
              }
            : undefined,
      },

      grafana: {
        enabled: true,
        adminUser: grafanaAdminUser,
        adminPassword: grafanaAdminPassword,
        service: {
          type: 'LoadBalancer',
          port: 3000,
          targetPort: 3000,
        },
        persistence: {
          enabled: true,
          storageClassName: storageClass,
          size: grafanaStorageSize,
        },
        sidecar: {
          dashboards: {
            enabled: true,
            folder: '/var/lib/grafana/dashboards/custom',
            label: 'grafana_dashboard',
            folderAnnotation: 'grafana_folder',
          },
          datasources: {
            enabled: true,
            label: 'grafana_datasource',
            labelValue: '1',
          },
        },
        additionalDataSources: [
          {
            name: 'Loki',
            type: 'loki',
            access: 'proxy',
            url: 'http://loki-stack.loki-stack.svc.homelab:3100',
            isDefault: false,
            editable: true,
            jsonData: {
              maxLines: 1000,
              derivedFields: [
                {
                  datasourceUid: 'prometheus',
                  matcherRegex: 'traceID=(\\w+)',
                  name: 'TraceID',
                  url: '$${__value.raw}',
                },
              ],
            },
          },
        ],
      },

      kubeStateMetrics: { enabled: true, tolerations: controlPlaneTolerations },
      nodeExporter: {
        enabled: true,
        tolerations: controlPlaneTolerations,
      },

      prometheus: {
        enabled: true,
        service: {
          type: 'LoadBalancer',
          port: 9090,
          targetPort: 9090,
        },
        prometheusSpec: {
          ...promSpecCommon,
          storageSpec: {
            volumeClaimTemplate: {
              spec: {
                storageClassName: storageClass,
                accessModes: ['ReadWriteOnce'],
                resources: { requests: { storage: prometheusStorageSize } },
              },
            },
          },
        },
      },

      // Disable ALL default rules - we only want our custom ones
      defaultRules: {
        create: false, // This disables ALL default rules
      },

      // Custom alert rules - Simple and practical for homelab
      additionalPrometheusRulesMap: {
        'homelab-alerts': {
          groups: [
            {
              name: 'homelab.critical',
              interval: '30s',
              rules: [
                // Critical: Node down
                {
                  alert: 'NodeDown',
                  expr: 'up{job="node-exporter"} == 0',
                  for: '3m',
                  labels: {
                    severity: 'critical',
                    category: 'infrastructure',
                  },
                  annotations: {
                    summary: '🔴 Node {{ $labels.instance }} is DOWN',
                    description:
                      'Kubernetes node {{ $labels.instance }} has been unreachable for more than 3 minutes. Immediate action required!',
                  },
                },
                // Critical: Pod crash looping
                {
                  alert: 'PodCrashLooping',
                  expr: 'rate(kube_pod_container_status_restarts_total[15m]) > 0.001',
                  for: '5m',
                  labels: {
                    severity: 'critical',
                    category: 'pods',
                  },
                  annotations: {
                    summary: '🔴 Pod {{ $labels.namespace }}/{{ $labels.pod }} is crash looping',
                    description:
                      'Pod {{ $labels.pod }} in namespace {{ $labels.namespace }} has restarted {{ $value | humanize }} times in the last 15 minutes',
                  },
                },
                // Critical: PVC pending
                {
                  alert: 'PersistentVolumeClaimPending',
                  expr: 'kube_persistentvolumeclaim_status_phase{phase="Pending"} == 1',
                  for: '5m',
                  labels: {
                    severity: 'critical',
                    category: 'storage',
                  },
                  annotations: {
                    summary: '🔴 PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} is pending',
                    description:
                      'PVC {{ $labels.persistentvolumeclaim }} in namespace {{ $labels.namespace }} has been pending for more than 5 minutes. Storage provisioning issue!',
                  },
                },
                // Critical: Disk space <10%
                {
                  alert: 'DiskSpaceCritical',
                  expr: '(node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) * 100 < 10',
                  for: '2m',
                  labels: {
                    severity: 'critical',
                    category: 'resources',
                  },
                  annotations: {
                    summary: '🔴 CRITICAL: Only {{ $value | humanize }}% disk space left on {{ $labels.instance }}',
                    description:
                      'Node {{ $labels.instance }} has less than 10% disk space remaining. Immediate cleanup required!',
                  },
                },
                // Critical: Memory >95%
                {
                  alert: 'MemoryHigh',
                  expr: '(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100 > 95',
                  for: '5m',
                  labels: {
                    severity: 'critical',
                    category: 'resources',
                  },
                  annotations: {
                    summary: '🔴 Memory usage {{ $value | humanize }}% on {{ $labels.instance }}',
                    description:
                      'Node {{ $labels.instance }} memory usage is above 95% for 5 minutes. OOM killer may activate!',
                  },
                },
                // Critical: API server down
                {
                  alert: 'KubernetesAPIServerDown',
                  expr: 'up{job="apiserver"} == 0',
                  for: '2m',
                  labels: {
                    severity: 'critical',
                    category: 'kubernetes',
                  },
                  annotations: {
                    summary: '🔴 Kubernetes API server is DOWN',
                    description:
                      'The Kubernetes API server has been down for more than 2 minutes. Cluster control plane is unavailable!',
                  },
                },
              ],
            },
            {
              name: 'homelab.warning',
              interval: '1m',
              rules: [
                // Warning: Disk space <20%
                {
                  alert: 'DiskSpaceWarning',
                  expr: '(node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) * 100 < 20',
                  for: '10m',
                  labels: {
                    severity: 'warning',
                    category: 'resources',
                  },
                  annotations: {
                    summary: '⚠️ Low disk space: {{ $value | humanize }}% left on {{ $labels.instance }}',
                    description:
                      'Node {{ $labels.instance }} has less than 20% disk space remaining. Consider cleanup soon.',
                  },
                },
                // Warning: Memory >85%
                {
                  alert: 'MemoryWarning',
                  expr: '(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100 > 85',
                  for: '10m',
                  labels: {
                    severity: 'warning',
                    category: 'resources',
                  },
                  annotations: {
                    summary: '⚠️ High memory usage: {{ $value | humanize }}% on {{ $labels.instance }}',
                    description: 'Node {{ $labels.instance }} memory usage is above 85% for 10 minutes.',
                  },
                },
                // Warning: CPU >90%
                {
                  alert: 'CPUHigh',
                  expr: '100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > 90',
                  for: '15m',
                  labels: {
                    severity: 'warning',
                    category: 'resources',
                  },
                  annotations: {
                    summary: '⚠️ High CPU usage: {{ $value | humanize }}% on {{ $labels.instance }}',
                    description: 'Node {{ $labels.instance }} CPU usage is above 90% for 15 minutes.',
                  },
                },
                // Warning: Pod not ready (excluding completed/succeeded pods)
                {
                  alert: 'PodNotReady',
                  expr: 'kube_pod_status_ready{condition="true"} == 0 and kube_pod_status_phase{phase!~"Succeeded|Failed"} == 1',
                  for: '10m',
                  labels: {
                    severity: 'warning',
                    category: 'pods',
                  },
                  annotations: {
                    summary: '⚠️ Pod {{ $labels.namespace }}/{{ $labels.pod }} not ready',
                    description:
                      'Pod {{ $labels.pod }} in namespace {{ $labels.namespace }} has been not ready for 10 minutes. Phase: {{ $labels.phase }}',
                  },
                },
              ],
            },
            {
              name: 'homelab.info',
              interval: '30s', // Check every 30 seconds to ensure we don't miss the time window
              rules: [
                // DAILY MORNING REPORT - 8:00 AM CEST (6:00 AM UTC)
                {
                  alert: 'DailyHomelabReport',
                  expr: 'hour() == 6 and minute() >= 0 and minute() < 5',
                  for: '0m',
                  labels: {
                    severity: 'info',
                    category: 'report',
                  },
                  annotations: {
                    summary: '🌅 Good Morning! Homelab Status Report',
                    description: `Good Morning! Homelab Status

📊 CURRENT METRICS:
🖥️ CPU: {{ range query "100 - (avg(rate(node_cpu_seconds_total{mode=\\"idle\\"}[5m])) * 100)" }}{{ .Value | printf "%.1f" }}{{ end }}%
💾 Memory: {{ range query "(1 - (sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes))) * 100" }}{{ .Value | printf "%.1f" }}{{ end }}%
🏠 Nodes: {{ range query "count(up{job=\\"node-exporter\\"} == 1)" }}{{ .Value | printf "%.0f" }}{{ end }} online
🚀 Pods: {{ range query "count(kube_pod_status_phase{phase=\\"Running\\"})" }}{{ .Value | printf "%.0f" }}{{ end }} running
💿 Disk: {{ range query "100 - (min(node_filesystem_avail_bytes{mountpoint=\\"/\\"} / node_filesystem_size_bytes{mountpoint=\\"/\\"}) * 100)" }}{{ .Value | printf "%.1f" }}{{ end }}% used

✅ SYSTEM STATUS:
• All systems operational
• Monitoring working perfectly
• No critical alerts

🔗 QUICK ACCESS:
📊 Grafana: http://192.168.1.201:3000
🚨 AlertManager: http://192.168.1.201:9093

Have a productive day! 🚀

🌅 Daily report at 8:00 AM CEST`,
                  },
                },
              ],
            },
          ],
        },
      },
    },
  },
  { dependsOn: [ns] },
)

// Auto-provision Grafana dashboards from local files
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dashboardsDir = '../dashboards'
let _dashboardConfigMaps: ConfigMap[] = []
if (existsSync(dashboardsDir)) {
  try {
    const files = readdirSync(dashboardsDir).filter((f) => f.endsWith('.json'))
    _dashboardConfigMaps = files.map((fileName) => {
      const json = readFileSync(join(dashboardsDir, fileName), 'utf-8')
      const cm = new ConfigMap(
        `grafana-dashboard-${fileName.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`,
        {
          metadata: {
            namespace: namespaceName,
            labels: { grafana_dashboard: '1' },
            annotations: { grafana_folder: 'custom' },
          },
          data: { [fileName]: json },
        },
        { dependsOn: [ns] },
      )
      return cm
    })
  } catch {
    // No dashboards directory or unreadable; skip silently
  }
}

export const namespace = ns.metadata.name
export const grafanaUrl = interpolate`http://${grafanaHost}`
export const alertmanagerUrl = interpolate`http://${alertmanagerHost}`
