'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download } from 'lucide-react';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import { formatInrFromPaise } from '@/lib/billing/money';

type InvoiceRow = {
  id: string;
  invoice_number: string;
  invoice_date: string;
  description: string;
  status: string;
  total_paise: number;
  currency: string;
};

type Profile = {
  legalName: string;
  gstin: string;
  address: string;
  stateCode: string;
  stateName: string;
};

type StateOption = { code: string; name: string };

export default function InvoicesApp() {
  const router = useRouter();
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [profile, setProfile] = useState<Profile>({
    legalName: '',
    gstin: '',
    address: '',
    stateCode: '',
    stateName: '',
  });
  const [states, setStates] = useState<StateOption[]>([]);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const response = await fetch('/api/billing/invoices', { cache: 'no-store' }).catch(() => null);
    if (!response?.ok) {
      setNotice('Could not load invoices.');
      return;
    }
    const payload = await response.json() as {
      invoices?: InvoiceRow[];
      profile?: Profile;
      states?: StateOption[];
    };
    setInvoices(Array.isArray(payload.invoices) ? payload.invoices : []);
    if (payload.profile) setProfile(payload.profile);
    if (Array.isArray(payload.states)) setStates(payload.states);
  };

  useEffect(() => {
    void load();
  }, []);

  const saveProfile = async () => {
    setSaving(true);
    setNotice('');
    try {
      const response = await fetch('/api/billing/invoices', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile),
      });
      const payload = await response.json() as { profile?: Profile; error?: string };
      if (!response.ok) {
        setNotice(payload.error || 'Could not save GST details.');
        return;
      }
      if (payload.profile) setProfile(payload.profile);
      setNotice('Billing GST details saved. Future invoices will use this place of supply.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent font-sans">
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <WorkspaceCommandHeader section="Invoices" onExit={() => router.push('/')} />
        <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
          <div className="mx-auto max-w-5xl">
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Account</p>
            <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-black">Invoices</h2>
            <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-zinc-500">
              GST tax invoices are generated after a successful Razorpay payment. Add your GSTIN if you need a B2B invoice.
            </p>

            {notice ? (
              <p className="mt-6 border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-[13px] text-amber-100">{notice}</p>
            ) : null}

            <div className="mt-8 app-paper p-5">
              <h3 className="font-display text-lg text-black">GST billing details</h3>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <label className="text-[12px] text-neutral-600">
                  Legal name
                  <input
                    value={profile.legalName}
                    onChange={(event) => setProfile((current) => ({ ...current, legalName: event.target.value }))}
                    className="mt-1 w-full border-[3px] border-black bg-white px-3 py-2 text-sm text-black outline-none"
                  />
                </label>
                <label className="text-[12px] text-neutral-600">
                  GSTIN
                  <input
                    value={profile.gstin}
                    onChange={(event) => setProfile((current) => ({ ...current, gstin: event.target.value.toUpperCase() }))}
                    className="mt-1 w-full border-[3px] border-black bg-white px-3 py-2 text-sm text-black outline-none"
                    placeholder="29ABCDE1234F1Z5"
                  />
                </label>
                <label className="text-[12px] text-neutral-600 md:col-span-2">
                  Address
                  <textarea
                    value={profile.address}
                    onChange={(event) => setProfile((current) => ({ ...current, address: event.target.value }))}
                    className="mt-1 min-h-[72px] w-full border-[3px] border-black bg-white px-3 py-2 text-sm text-black outline-none"
                  />
                </label>
                <label className="text-[12px] text-neutral-600 md:col-span-2">
                  State (place of supply)
                  <select
                    value={profile.stateCode}
                    onChange={(event) => {
                      const selected = states.find((state) => state.code === event.target.value);
                      setProfile((current) => ({
                        ...current,
                        stateCode: event.target.value,
                        stateName: selected?.name || '',
                      }));
                    }}
                    className="mt-1 w-full border-[3px] border-black bg-white px-3 py-2 text-sm text-black outline-none"
                  >
                    <option value="">Same as seller (intra-state)</option>
                    {states.map((state) => (
                      <option key={state.code} value={state.code}>
                        {state.code} — {state.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveProfile()}
                className="mt-4 border-[3px] border-black bg-black px-4 py-2 text-sm font-bold text-white shadow-[4px_4px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save GST details'}
              </button>
            </div>

            <div className="mt-8 app-paper">
              <table className="w-full text-left text-sm">
                <thead className="border-b-[3px] border-black bg-neutral-100 font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-600">
                  <tr>
                    <th className="px-4 py-3">Invoice</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Description</th>
                    <th className="px-4 py-3">Amount</th>
                    <th className="px-4 py-3"> </th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-neutral-500">No invoices yet.</td>
                    </tr>
                  ) : invoices.map((invoice) => (
                    <tr key={invoice.id} className="border-t-[3px] border-black">
                      <td className="px-4 py-3 font-mono text-[12px] text-black">{invoice.invoice_number}</td>
                      <td className="px-4 py-3 text-neutral-600">{invoice.invoice_date}</td>
                      <td className="px-4 py-3 text-neutral-700">{invoice.description}</td>
                      <td className="px-4 py-3 text-black">{formatInrFromPaise(invoice.total_paise)}</td>
                      <td className="px-4 py-3">
                        <a
                          href={`/api/billing/invoices/${invoice.id}/pdf`}
                          className="inline-flex items-center gap-1 text-[12px] font-bold text-black underline"
                        >
                          <Download className="h-3.5 w-3.5" />
                          PDF
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
