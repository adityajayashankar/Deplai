import { redirect } from 'next/navigation';

const GITHUB_APP_INSTALL_URL = 'https://github.com/apps/deplai-gitapp-aj/installations/new';

export default function DashboardProjectsRedirectPage() {
  redirect(GITHUB_APP_INSTALL_URL);
}
