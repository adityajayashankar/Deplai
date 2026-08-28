import { Suspense } from 'react';
import ManageInstancesApp from '@/features/deployment/ManageInstancesApp';

export default function DashboardInstancesPage() {
  return (
    <Suspense fallback={<div className="h-full bg-white" />}>
      <ManageInstancesApp />
    </Suspense>
  );
}
