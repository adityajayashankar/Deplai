'use client';

import type { ReactNode } from 'react';
import { ScanProvider } from '@/lib/scan-context';
import { LLMProviderContext } from '@/lib/llm-context';
import { DashboardWorkspaceFrame } from '@/features/workspace/WorkspaceNav';

export default function ProfileLayout({ children }: { children: ReactNode }) {
  return (
    <LLMProviderContext>
      <ScanProvider>
        <DashboardWorkspaceFrame>{children}</DashboardWorkspaceFrame>
      </ScanProvider>
    </LLMProviderContext>
  );
}
