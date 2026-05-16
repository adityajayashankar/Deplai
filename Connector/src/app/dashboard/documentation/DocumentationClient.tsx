'use client';

import dynamic from 'next/dynamic';

const DocumentationApp = dynamic(() => import('@/features/dashboard/DocumentationApp'), {
  ssr: false,
});

export default function DocumentationClient() {
  return <DocumentationApp />;
}
