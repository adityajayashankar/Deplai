import { redirect } from 'next/navigation';

export default function DashboardBillingCreditsPage() {
  redirect('/dashboard/billing?view=credits');
}
