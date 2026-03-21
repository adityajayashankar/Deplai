'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import LoadingSpinner, { LoadingScreen } from '@/components/loading-spinner';
import ThemeToggle from '@/components/theme-toggle';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { PopupProvider, usePopup } from '@/components/popup';

interface FileItem {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size: number | null;
}

const LANGUAGE_MAP: Record<string, string> = {
  js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
  py: 'python', java: 'java', c: 'c', cpp: 'cpp', cs: 'csharp',
  php: 'php', rb: 'ruby', go: 'go', rs: 'rust', swift: 'swift',
  kt: 'kotlin', json: 'json', xml: 'xml', html: 'html', css: 'css',
  scss: 'scss', sql: 'sql', sh: 'bash', yaml: 'yaml', yml: 'yaml',
  md: 'markdown', txt: 'text',
};

function getLanguageFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return LANGUAGE_MAP[ext] || 'text';
}

export default function RepositoryBrowser() {
  return (
    <PopupProvider>
      <Suspense fallback={<LoadingScreen />}>
        <RepositoryBrowserContent />
      </Suspense>
    </PopupProvider>
  );
}

function RepositoryBrowserContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  
  // Determine project type
  const projectType = searchParams.get('type') || 'github';
  const isLocal = projectType === 'local';
  
  // GitHub params
  const owner = searchParams.get('owner') || '';
  const repo = searchParams.get('repo') || '';
  
  // Local project params
  const projectId = searchParams.get('project_id') || '';
  
  const currentPath = searchParams.get('path') || '';

  const { showPopup } = usePopup();
  const [authLoading, setAuthLoading] = useState(true);
  const [projectName, setProjectName] = useState('');
  const [contents, setContents] = useState<FileItem[]>([]);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSuspended, setIsSuspended] = useState(false);

  // Check authentication first
  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (!authLoading) {
      if (isLocal && projectId) {
        fetchProjectDetails();
        fetchContents();
      } else if (!isLocal && owner && repo) {
        setProjectName(repo);
        fetchContents();
      }
    }
  }, [owner, repo, projectId, currentPath, authLoading, isLocal]);

  async function checkAuth() {
    try {
      const res = await fetch('/api/auth/session');
      const session = await res.json();
      
      if (!session.isLoggedIn) {
        router.push('/');
        return;
      }
      
      setAuthLoading(false);
    } catch (error) {
      console.error('Auth check failed:', error);
      router.push('/');
    }
  }

  async function fetchProjectDetails() {
    if (!isLocal || !projectId) return;
    
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      if (res.ok) {
        const data = await res.json();
        setProjectName(data.project.name);
      }
    } catch (err) {
      console.error('Failed to fetch project details:', err);
    }
  }

  function apiUrl(endpoint: 'contents' | 'file', filePath: string) {
    if (isLocal) {
      return `/api/projects/local/${endpoint}?project_id=${projectId}&path=${filePath}`;
    }
    return `/api/repositories/${endpoint}?owner=${owner}&repo=${repo}&path=${filePath}`;
  }

  async function fetchContents() {
    setLoading(true);
    setError(null);
    setFileContent(null);
    setSelectedFile(null);
    setIsSuspended(false);

    try {
      const res = await fetch(apiUrl('contents', currentPath));

      if (!res.ok) {
        const data = await res.json();
        if (data.suspended) {
          setIsSuspended(true);
          return;
        }
        throw new Error(data.error || 'Failed to fetch contents');
      }

      const data = await res.json();
      setContents(data.contents || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleFileClick(item: FileItem) {
    if (item.type === 'file') {
      setSelectedFile(item.path);
      setLoading(true);

      try {
        const res = await fetch(apiUrl('file', item.path));
        
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to fetch file');
        }

        const data = await res.json();
        setFileContent(data.content);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
  }

  async function handleRefresh() {
    if (isLocal) {
      await fetchContents();
      return;
    }

    setRefreshing(true);
    try {
      const res = await fetch('/api/repositories/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner, repo }),
      });

      if (!res.ok) {
        const data = await res.json();
        if (data.suspended) {
          setIsSuspended(true);
          showPopup({
            type: 'error',
            message: 'GitHub App installation is suspended. Unsuspend it from your GitHub settings to restore access.',
          });
          return;
        }
        throw new Error(data.error || 'Failed to refresh');
      }

      await fetchContents();
    } catch (err: any) {
      showPopup({ type: 'error', message: err.message });
    } finally {
      setRefreshing(false);
    }
  }

  function buildNavigationUrl(path: string) {
    if (isLocal) {
      return `/dashboard/codeview?project_id=${projectId}&type=local${path ? `&path=${path}` : ''}`;
    } else {
      return `/dashboard/codeview?owner=${owner}&repo=${repo}&type=github${path ? `&path=${path}` : ''}`;
    }
  }

  function handleDirectoryClick(itemPath: string) {
    window.location.href = buildNavigationUrl(itemPath);
  }

  const pathParts = currentPath ? currentPath.split('/') : [];
  const breadcrumbs = [
    { name: projectName || 'Project', path: '' },
    ...pathParts.map((part, index) => ({
      name: part,
      path: pathParts.slice(0, index + 1).join('/'),
    })),
  ];

  if (authLoading) {
    return <LoadingScreen />;
  }

  if ((!isLocal && (!owner || !repo)) || (isLocal && !projectId)) {
    return (
      <div className="min-h-screen bg-header flex items-center justify-center">
        <div className="text-center">
          <p className="text-muted mb-4">No project selected</p>
          <Link href="/dashboard" className="text-blue-600 dark:text-blue-400 hover:underline">
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-header">
      {/* Header */}
      <header className="bg-header border-b border-border sticky top-0 z-10">
        <div className="container mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <Link href="/dashboard" className="flex items-center space-x-2">
                <span className="text-xl font-bold text-foreground">
                  Code View
                </span>
              </Link>
            </div>

            <div className="flex items-center space-x-3">
              <ThemeToggle />
              
              {!isLocal && (
                <button
                  onClick={handleRefresh}
                  disabled={refreshing}
                  className="flex items-center space-x-2 px-4 py-2 text-sm text-foreground hover:bg-[#fffafa] dark:hover:bg-surface-hover rounded-lg transition disabled:opacity-50"
                >
                  <svg
                    className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                  <span>{refreshing ? 'Refreshing...' : 'Refresh'}</span>
                </button>
              )}

              <Link
                href="/dashboard"
                className="hover:opacity-70 transition"
                title="Back to Dashboard"
              >
                <svg
                  width="24"
                  height="25"
                  viewBox="0 0 24 25"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  className="dark:invert"
                >
                  <path
                    d="M18.125 6.62502C18.125 6.32168 17.9423 6.0482 17.662 5.93211C17.3818 5.81603 17.0592 5.88019 16.8447 6.09469L10.5947 12.3447C10.3018 12.6376 10.3018 13.1125 10.5947 13.4054L16.8447 19.6554C17.0592 19.8699 17.3818 19.934 17.662 19.8179C17.9423 19.7018 18.125 19.4284 18.125 19.125V6.62502Z"
                    fill="#323544"
                  />
                  <path
                    d="M13.4053 7.15535C13.6982 6.86246 13.6982 6.38758 13.4053 6.09469C13.1124 5.8018 12.6376 5.8018 12.3447 6.09469L6.09467 12.3447C5.80178 12.6376 5.80178 13.1125 6.09467 13.4054L12.3447 19.6554C12.6376 19.9482 13.1124 19.9482 13.4053 19.6554C13.6982 19.3625 13.6982 18.8876 13.4053 18.5947L7.68566 12.875L13.4053 7.15535Z"
                    fill="#323544"
                  />
                </svg>
              </Link>
            </div>
          </div>

          {/* Breadcrumb */}
          <div className="flex items-center space-x-2 mt-3 text-sm">
            {breadcrumbs.map((crumb, index) => (
              <div key={index} className="flex items-center space-x-2">
                {index > 0 && <span className="text-gray-400">/</span>}
                {index === breadcrumbs.length - 1 ? (
                  <span className="text-foreground font-medium">{crumb.name}</span>
                ) : (
                  <Link
                    href={buildNavigationUrl(crumb.path)}
                    className="text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {crumb.name}
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="container mx-auto px-6 py-8">
        <div className={`grid gap-6 ${fileContent ? 'lg:grid-cols-2' : 'lg:grid-cols-1'}`}>
          {/* File Browser */}
          <div className="bg-surface rounded-xl border border-border">
            <div className="p-6 max-h-150 overflow-y-auto">
              {!isLocal && isSuspended ? (
                <div className="text-center py-16">
                  <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 bg-orange-100 dark:bg-orange-700">
                    <svg className="w-8 h-8 text-orange-600 dark:text-white" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold mb-2 text-orange-600 dark:text-white">Installation Suspended</h3>
                  <p className="text-muted dark:text-gray-300 text-sm mb-4">
                    Your GitHub App has been suspended.<br />
                  </p>
                </div>
              ) : loading && !fileContent ? (
                <LoadingSpinner size="md" className="py-12" />
              ) : error ? (
                <div className="text-center py-12">
                  <p className="text-red-600 dark:text-red-400">{error}</p>
                  <button
                    onClick={fetchContents}
                    className="mt-4 text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    Try again
                  </button>
                </div>
              ) : (
                <div>
                  {/* Parent directory link */}
                  {currentPath && (
                    <>
                      <Link
                        href={buildNavigationUrl(
                          currentPath.includes('/')
                            ? currentPath.split('/').slice(0, -1).join('/')
                            : ''
                        )}
                        className="flex items-center space-x-3 p-4 hover:bg-surface-hover transition border-l-4 border-l-transparent"
                      >
                        <svg
                          className="w-5 h-5 text-gray-400"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M10 19l-7-7m0 0l7-7m-7 7h18"
                          />
                        </svg>
                        <span className="text-muted">..</span>
                      </Link>
                      <div className="border-b border-border"></div>
                    </>
                  )}

                  {contents.map((item, index) => (
                    <div key={item.path}>
                      <div
                        onClick={() =>
                          item.type === 'dir'
                            ? handleDirectoryClick(item.path)
                            : handleFileClick(item)
                        }
                        className={`flex items-center justify-between p-4 cursor-pointer transition ${
                          selectedFile === item.path
                            ? 'bg-blue-50 dark:bg-blue-900/20 border-l-4 border-l-blue-600 dark:border-l-blue-400'
                            : 'hover:bg-surface-hover border-l-4 border-l-transparent'
                        }`}
                      >
                        <div className="flex items-center space-x-3 flex-1">
                          {item.type === 'dir' ? (
                            <svg
                              className="w-5 h-5 text-blue-500 dark:text-blue-400"
                              fill="currentColor"
                              viewBox="0 0 20 20"
                            >
                              <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                            </svg>
                          ) : (
                            <svg
                              className="w-5 h-5 text-gray-400"
                              fill="currentColor"
                              viewBox="0 0 20 20"
                            >
                              <path
                                fillRule="evenodd"
                                d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"
                                clipRule="evenodd"
                              />
                            </svg>
                          )}
                          <span className="text-foreground font-medium">{item.name}</span>
                        </div>

                        {item.type === 'file' && item.size !== null && (
                          <span className="text-xs text-muted">
                            {(item.size / 1024).toFixed(1)} KB
                          </span>
                        )}
                      </div>
                      {index < contents.length - 1 && (
                        <div className="border-b border-border"></div>
                      )}
                    </div>
                  ))}

                  {contents.length === 0 && (
                    <div className="text-center py-12 text-muted">
                      Empty directory
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* File Content Viewer */}
          {fileContent && (
            <div className="bg-surface rounded-xl border border-border">
              <div className="p-6 border-b border-border">
                <h2 className="text-lg font-semibold text-foreground">
                  {selectedFile ? selectedFile.split('/').pop() : 'Select a file'}
                </h2>
              </div>

              <div className="p-6">
                <div className="rounded-lg overflow-hidden">
                  <SyntaxHighlighter
                    language={getLanguageFromFilename(selectedFile || '')}
                    style={vscDarkPlus}
                    showLineNumbers={true}
                    customStyle={{
                      margin: 0,
                      maxHeight: '600px',
                      fontSize: '14px',
                    }}
                  >
                    {fileContent}
                  </SyntaxHighlighter>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="container mx-auto px-6 py-8 border-t border-border">
        <div className="text-center">
          <p className="text-muted text-sm mt-1">
            {isLocal
              ? 'Note: Files are stored temporarily, edits made to this project wont get reflected here'
              : 'Note: Changes pushed from your IDE to GitHub will appear here after you click Refresh'}
          </p>
        </div>
      </div>
    </div>
  );
}
