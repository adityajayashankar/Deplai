import { Suspense } from 'react';
import DeploymentTrackApp from '@/features/deployment/DeploymentTrackApp';

export default function DashboardDeployPage() {
  return (
    <Suspense fallback={<div className="h-full bg-white" />}>
      <DeploymentTrackApp />
    </Suspense>
  );
}
