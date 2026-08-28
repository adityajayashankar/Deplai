import DashboardHomeApp from '@/features/dashboard/DashboardHomeApp';

/** Direct link to the same Settings workspace exposed by the dashboard sidebar. */
export default function DashboardSettingsPage() {
  return <DashboardHomeApp initialTab="settings" />;
}
