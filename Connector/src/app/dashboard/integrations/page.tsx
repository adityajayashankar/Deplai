import DashboardHomeApp from '@/features/dashboard/DashboardHomeApp';

/** Account → Integrations, opening the workspace integrations settings. */
export default function DashboardIntegrationsPage() {
  return <DashboardHomeApp initialTab="integrations" />;
}
