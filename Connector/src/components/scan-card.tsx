'use client';

import { useState, useEffect, useRef } from 'react';
import { usePopup } from '@/components/popup';
import { FiShield, FiCode, FiPackage, FiGlobe, FiX } from 'react-icons/fi';

type ScanType = 'sast' | 'sca' | 'all';

interface ScanModalProps {
  isOpen: boolean;
  onClose: () => void;
  project: {
    id: string;
    name?: string;
    repo?: string;
    owner?: string;
    installationId?: string;
    type: 'local' | 'github';
  } | null;
  onScanComplete: (result: ScanResult) => void;
}

interface ScanResult {
  projectId: string;
  projectName: string;
}

const SCAN_OPTIONS = [
  {
    id: 'sast' as ScanType,
    label: 'SAST',
    sublabel: 'Static Application Security Testing',
    description: 'Scans source code for vulnerabilities, hardcoded secrets, and insecure patterns using Bearer.',
    Icon: FiCode,
    colorCls: 'bg-indigo-500/15 border-indigo-500/30 text-indigo-400',
  },
  {
    id: 'sca' as ScanType,
    label: 'SCA',
    sublabel: 'Software Composition Analysis',
    description: 'Audits open-source dependencies for known CVEs using Syft + Grype.',
    Icon: FiPackage,
    colorCls: 'bg-violet-500/15 border-violet-500/30 text-violet-400',
  },
  {
    id: 'all' as ScanType,
    label: 'Full Scan',
    sublabel: 'SAST + SCA combined',
    description: 'Runs both analyzers in parallel for complete coverage.',
    Icon: FiShield,
    colorCls: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400',
    recommended: true,
  },
] as const;

export default function ScanModal({ isOpen, onClose, project, onScanComplete }: ScanModalProps) {
  const { showPopup } = usePopup();
  const [selectedType, setSelectedType] = useState<ScanType | null>(null);
  const [step, setStep] = useState<'select' | 'thinking' | 'launching'>('select');
  const [visible, setVisible] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Reset and animate in when opened
  useEffect(() => {
    if (isOpen) {
      setStep('select');
      setSelectedType(null);
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
    }
  }, [isOpen]);

  // Scroll chat to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [step, selectedType]);

  if (!isOpen || !project) return null;

  const projectName = project.type === 'local' ? project.name : project.repo;

  const handleClose = () => {
    setVisible(false);
    setTimeout(onClose, 150);
  };

  const handleSelect = async (type: ScanType) => {
    if (step !== 'select') return;
    setSelectedType(type);
    setStep('thinking');

    // Brief pause so the user sees the "thinking" dots before we fire
    await new Promise(r => setTimeout(r, 650));
    setStep('launching');

    const name = projectName || 'Unknown';
    try {
      const response = await fetch('/api/scan/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: project.id,
          project_name: name,
          project_type: project.type,
          installation_id: project.installationId,
          owner: project.owner,
          repo: project.repo,
          scan_type: type,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(errorData?.error || 'Backend request failed');
      }

      await response.json();
      onScanComplete({ projectId: project.id, projectName: name });
      handleClose();
    } catch (error: any) {
      showPopup({
        type: 'error',
        message: error?.message || 'Failed to connect to the backend. Please ensure the server is running.',
      });
      setStep('select');
      setSelectedType(null);
    }
  };

  const selectedOption = SCAN_OPTIONS.find(o => o.id === selectedType);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-150 ${visible ? 'opacity-100' : 'opacity-0'}`}
        onClick={handleClose}
      />

      {/* Panel */}
      <div
        className={`relative w-full max-w-lg mx-4 bg-[#0a0a0b] border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden transition-all duration-200 ${
          visible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-2'
        }`}
        style={{ maxHeight: '85vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center">
              <FiShield className="w-3.5 h-3.5 text-indigo-400" />
            </div>
            <span className="text-sm font-semibold text-white">DeplAI Security Scanner</span>
          </div>
          <button onClick={handleClose} className="text-zinc-500 hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition">
            <FiX className="w-4 h-4" />
          </button>
        </div>

        {/* Chat area */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4 min-h-0">

          {/* Bot opening message */}
          <div className="flex items-start gap-3">
            <div className="w-7 h-7 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0 mt-0.5">
              <FiShield className="w-3.5 h-3.5 text-indigo-400" />
            </div>
            <div className="bg-white/5 border border-white/10 rounded-2xl rounded-tl-sm px-4 py-3 max-w-[80%]">
              <p className="text-sm text-zinc-200 leading-relaxed">
                I&apos;ll scan <span className="font-semibold text-white">{projectName}</span> for security vulnerabilities.
              </p>
              <p className="text-sm text-zinc-400 mt-1.5">Which analysis should I run?</p>
            </div>
          </div>

          {/* Scan type options — hidden once a choice is made */}
          {step === 'select' && (
            <div className="pl-10 space-y-2">
              {SCAN_OPTIONS.map(({ id, label, sublabel, description, Icon, colorCls, ...rest }) => (
                <button
                  key={id}
                  onClick={() => handleSelect(id)}
                  className="w-full flex items-start gap-3 px-4 py-3.5 rounded-xl border border-white/10 bg-white/3 hover:bg-white/7 hover:border-indigo-500/30 transition-all text-left"
                >
                  <div className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${colorCls}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-white">{label}</span>
                      <span className="text-xs text-zinc-500">{sublabel}</span>
                      {(rest as any).recommended && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">Recommended</span>
                      )}
                    </div>
                    <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">{description}</p>
                  </div>
                </button>
              ))}

              {/* DAST — placeholder (coming soon) */}
              <div className="w-full flex items-start gap-3 px-4 py-3.5 rounded-xl border border-white/5 bg-white/2 opacity-50 cursor-not-allowed">
                <div className="w-8 h-8 rounded-lg border bg-zinc-900 border-zinc-700/30 flex items-center justify-center shrink-0 text-zinc-600">
                  <FiGlobe className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-zinc-500">DAST</span>
                    <span className="text-xs text-zinc-600">Dynamic Application Security Testing</span>
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 border border-zinc-700">Coming Soon</span>
                  </div>
                  <p className="text-xs text-zinc-600 mt-0.5 leading-relaxed">Live traffic analysis and fuzzing against a running application.</p>
                </div>
              </div>
            </div>
          )}

          {/* User reply bubble — shown once a type is selected */}
          {selectedType && (
            <div className="flex justify-end">
              <div className="bg-indigo-600 rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[70%]">
                <p className="text-sm font-medium text-white">
                  {selectedOption?.label} — {selectedOption?.sublabel}
                </p>
              </div>
            </div>
          )}

          {/* Bot response after selection */}
          {(step === 'thinking' || step === 'launching') && (
            <div className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0 mt-0.5">
                <FiShield className="w-3.5 h-3.5 text-indigo-400" />
              </div>
              <div className="bg-white/5 border border-white/10 rounded-2xl rounded-tl-sm px-4 py-3 max-w-[80%]">
                {step === 'thinking' ? (
                  <div className="flex items-center gap-1.5 py-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: '160ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: '320ms' }} />
                  </div>
                ) : (
                  <p className="text-sm text-zinc-200 leading-relaxed">
                    Launching <span className="font-semibold text-white">{selectedOption?.label}</span> on{' '}
                    <span className="font-semibold text-white">{projectName}</span>. Switching to the scan monitor…
                  </p>
                )}
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>
      </div>
    </div>
  );
}
