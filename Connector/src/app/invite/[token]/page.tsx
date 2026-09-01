import AcceptInvitationApp from '@/features/organizations/AcceptInvitationApp';

export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <AcceptInvitationApp token={token} />;
}
