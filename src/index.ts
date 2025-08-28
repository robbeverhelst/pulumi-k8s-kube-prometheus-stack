import { config, Helm } from '@homelab/shared'
import { secret } from '@pulumi/pulumi'

const cfg = config('kube-prometheus-stack')

const grafanaPassword = secret(process.env.GRAFANA_ADMIN_PASSWORD || cfg.require('grafanaAdminPassword'))

const prometheus = new Helm('kube-prometheus-stack', {
  namespace: cfg.get('namespace', 'kube-prometheus-stack'),
  chart: 'kube-prometheus-stack',
  repo: 'https://prometheus-community.github.io/helm-charts',
  version: process.env.KUBE_PROMETHEUS_STACK_VERSION || cfg.get('version'),
  values: {
    prometheus: {
      prometheusSpec: {
        storageSpec: {
          volumeClaimTemplate: {
            spec: {
              storageClassName: cfg.get('storageClass', 'truenas-hdd-mirror-iscsi'),
              resources: { requests: { storage: cfg.get('prometheusStorageSize', '200Gi') } },
            },
          },
        },
        retention: cfg.get('retention', '30d'),
        resources: {
          requests: { cpu: '500m', memory: '2Gi' },
          limits: { cpu: '2', memory: '6Gi' },
        },
      },
    },
    grafana: {
      enabled: true,
      adminUser: cfg.get('grafanaAdminUser', 'admin'),
      adminPassword: grafanaPassword,
      persistence: {
        enabled: true,
        storageClassName: cfg.get('storageClass', 'truenas-hdd-mirror-iscsi'),
        size: cfg.get('grafanaStorageSize', '10Gi'),
      },
      ingress: {
        enabled: cfg.bool('enableIngress', true),
        ingressClassName: cfg.get('ingressClassName'),
        hosts: [cfg.get('grafanaHost')].filter(Boolean),
      },
    },
    alertmanager: {
      alertmanagerSpec: {
        storage: {
          volumeClaimTemplate: {
            spec: {
              storageClassName: cfg.get('storageClass', 'truenas-hdd-mirror-iscsi'),
              resources: { requests: { storage: cfg.get('alertmanagerStorageSize', '10Gi') } },
            },
          },
        },
      },
    },
  },
})

export const namespace = prometheus.namespace.metadata.name
export const release = prometheus.release.name
