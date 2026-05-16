import { Suspense } from 'react';
import DeploymentTrackApp from '@/features/deployment/DeploymentTrackApp';

export default function DashboardDeployPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <DeploymentTrackApp />
    </Suspense>
  );
}
