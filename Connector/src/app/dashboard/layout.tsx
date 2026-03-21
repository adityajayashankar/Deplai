'use client';

import { ScanProvider } from '@/lib/scan-context';
import { LLMProviderContext } from '@/lib/llm-context';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <LLMProviderContext>
      <ScanProvider>
        {children}
      </ScanProvider>
    </LLMProviderContext>
  );
}
