'use client';

import {
  PlatformModelPicker,
  type PlatformModelValue,
} from '@/features/ai-platform/PlatformModelPicker';

export type RemediationModelValue = PlatformModelValue;

export function RemediationModelPicker({
  value,
  onChange,
}: {
  value: RemediationModelValue;
  onChange: (next: RemediationModelValue) => void;
}) {
  return <PlatformModelPicker value={value} onChange={onChange} workNoun="remediation" />;
}
