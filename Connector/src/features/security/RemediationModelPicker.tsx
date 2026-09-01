'use client';

import {
  PlatformModelPicker,
  type PlatformModelValue,
} from '@/features/ai-platform/PlatformModelPicker';

export type RemediationModelValue = PlatformModelValue;

export function RemediationModelPicker({
  value,
  onChange,
  persistKey,
}: {
  value: RemediationModelValue;
  onChange: (next: RemediationModelValue) => void;
  persistKey?: string;
}) {
  return (
    <PlatformModelPicker
      value={value}
      onChange={onChange}
      workNoun="remediation"
      persistKey={persistKey}
      setupUrl="/api/security/remediation-setup"
    />
  );
}
