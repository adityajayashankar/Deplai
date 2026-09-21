import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import BuildWorkspace from '@/features/deplai-build/BuildWorkspace';

export default async function AgentsPage() {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/auth/login');
  return <BuildWorkspace />;
}
