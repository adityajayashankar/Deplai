'use client';

import { Suspense } from 'react';
import CustomizationConsoleApp from '@/features/dashboard/CustomizationConsoleApp';

export default function DashboardCustomizationPage() {
  return (
    <div className="h-screen">
      <Suspense fallback={null}>
        <CustomizationConsoleApp />
      </Suspense>
    </div>
  );
}
