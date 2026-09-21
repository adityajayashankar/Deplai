import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import SecretEntry from '@/features/deplai-build/SecretEntry';

export default async function BuildSecretsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!await getAuthenticatedUser()) redirect('/auth/login');
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === 'string' ? params[key] as string : '';
  return <SecretEntry sessionId={value('session_id')} projectId={value('project_id')} organizationId={value('organization_id')} />;
}
