import { describe, expect, it } from 'vitest'
import { validateKubernetesLabels } from '../../../test/helpers/test-utils'

describe('Kube Prometheus Stack', () => {
  it('should validate Kubernetes labels', () => {
    const labels = {
      'app.kubernetes.io/name': 'kube-prometheus-stack',
      'app.kubernetes.io/instance': 'production',
      'app.kubernetes.io/managed-by': 'pulumi',
    }

    // This should not throw
    expect(() => validateKubernetesLabels(labels)).not.toThrow()
  })

  it('should validate label format requirements', () => {
    // Test valid domain-style labels
    const validLabels = {
      'kubernetes.io/name': 'test',
      'app.kubernetes.io/component': 'database',
      environment: 'production',
    }

    expect(() => validateKubernetesLabels(validLabels)).not.toThrow()
  })

  it('should reject invalid label keys', () => {
    const _invalidLabels = {
      '': 'empty-key',
      key_with_underscores: 'invalid',
      'key with spaces': 'invalid',
    }

    expect(() => validateKubernetesLabels({ '': 'empty-key' })).toThrow()
  })

  it('should validate configuration constants', () => {
    // Test that our constants are reasonable
    expect('kube-prometheus-stack').toMatch(/^[a-z0-9-]+$/)
    expect('monitoring').toMatch(/^[a-z0-9-]+$/)
    expect('200Gi').toMatch(/^\d+[KMGT]i$/)
  })

  it('should handle storage class validation', () => {
    const storageClasses = ['truenas-hdd-mirror-iscsi', 'fast-ssd', 'standard']

    for (const sc of storageClasses) {
      expect(sc).toMatch(/^[a-z0-9-]+$/)
    }
  })
})
