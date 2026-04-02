import { FormEvent, useEffect, useMemo, useState } from "react";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ConfirmationState = {
  confirmed_tenant_id?: string;
  has_unconfirmed_changes?: boolean;
  is_confirmed?: boolean;
};

type AssetType =
  | "logo_light"
  | "logo_dark"
  | "favicon"
  | "og_image"
  | "hero_illustration"
  | "why_background"
  | "activities_background"
  | "curated_image";

type AssetPreview = {
  asset_type: AssetType;
  stored_path: string;
};

type ImplementOptions = {
  isRepairPass?: boolean;
  validatorIssues?: string[];
};

const ASSET_LABELS: Record<AssetType, string> = {
  logo_light: "Logo (Light)",
  logo_dark: "Logo (Dark)",
  favicon: "Favicon",
  og_image: "OG / Social Image",
  hero_illustration: "Hero Illustration",
  why_background: "Why-Section Background",
  activities_background: "Activities Background",
  curated_image: "Curated Section Image",
};

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8010";
const TENANT_STORAGE_KEY = "tenant-builder:selected-tenant-id";

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [manifest, setManifest] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [confirmedTenantId, setConfirmedTenantId] = useState<string>("");
  const [tenantId, setTenantId] = useState<string>("");

  // Asset upload state
  const [assetType, setAssetType] = useState<AssetType>("logo_light");
  const [assetFile, setAssetFile] = useState<File | null>(null);
  const [uploadedAssets, setUploadedAssets] = useState<AssetPreview[]>([]);
  const [assetLoading, setAssetLoading] = useState(false);

  const manifestText = useMemo(() => {
    return manifest ? JSON.stringify(manifest, null, 2) : "Manifest not loaded yet.";
  }, [manifest]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const storedTenantId = window.localStorage.getItem(TENANT_STORAGE_KEY);
    if (storedTenantId) {
      setTenantId(storedTenantId);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (tenantId.trim()) {
      window.localStorage.setItem(TENANT_STORAGE_KEY, tenantId.trim());
      return;
    }
    window.localStorage.removeItem(TENANT_STORAGE_KEY);
  }, [tenantId]);

  function getActiveTenantId(): string {
    return tenantId.trim();
  }

  function syncConfirmationState(confirmation?: ConfirmationState) {
    if (confirmation?.is_confirmed && confirmation.confirmed_tenant_id) {
      setConfirmedTenantId(confirmation.confirmed_tenant_id);
      return;
    }
    setConfirmedTenantId("");
  }

  async function uploadAsset(event: FormEvent) {
    event.preventDefault();
    const activeTenantId = getActiveTenantId();
    if (!activeTenantId) {
      setStatus("Enter tenant ID before uploading assets.");
      return;
    }
    if (!assetFile) {
      setStatus("Select a file before uploading.");
      return;
    }

    const form = new FormData();
    form.append("tenant_id", activeTenantId);
    form.append("asset_type", assetType);
    form.append("file", assetFile);

    setAssetLoading(true);
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/api/tenant/assets/upload`, {
        method: "POST",
        body: form,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Upload failed.");
      }
      // Refresh manifest to show the updated branding paths
      const manifestResponse = await fetch(
        `${API_BASE_URL}/manifest?tenant_id=${encodeURIComponent(activeTenantId)}`
      );
      const manifestData = await manifestResponse.json();
      setManifest(manifestData.manifest);
      syncConfirmationState(data.confirmation);

      setUploadedAssets((current) => {
        const without = current.filter((a) => a.asset_type !== assetType);
        return [...without, { asset_type: assetType, stored_path: data.stored_path }];
      });
      setAssetFile(null);
      setStatus(`Asset '${ASSET_LABELS[assetType]}' uploaded successfully. Confirm manifest before implementing.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Asset upload failed.");
    } finally {
      setAssetLoading(false);
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const activeTenantId = getActiveTenantId();
    if (!activeTenantId) {
      setStatus("Enter tenant ID before sending messages.");
      return;
    }
    const trimmed = input.trim();
    if (!trimmed || loading) {
      return;
    }

    setLoading(true);
    setStatus("");
    setMessages((current) => [...current, { role: "user", content: trimmed }]);

    try {
      const response = await fetch(`${API_BASE_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant_id: activeTenantId, message: trimmed }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Failed to send chat message.");
      }
      setMessages((current) => [...current, { role: "assistant", content: data.response }]);
      setManifest(data.manifest);
      syncConfirmationState(data.confirmation);
      if (data.confirmation?.has_unconfirmed_changes) {
        setStatus("Manifest updated. Confirm again before running implementation.");
      }
      setInput("");
    } catch (error) {
      setStatus("Failed to send chat message.");
    } finally {
      setLoading(false);
    }
  }

  async function loadManifest() {
    const activeTenantId = getActiveTenantId();
    if (!activeTenantId) {
      setStatus("Enter tenant ID before loading a manifest.");
      return;
    }
    setLoading(true);
    setStatus("");
    try {
      const response = await fetch(
        `${API_BASE_URL}/manifest?tenant_id=${encodeURIComponent(activeTenantId)}`
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Failed to load manifest.");
      }
      setManifest(data.manifest);
      syncConfirmationState(data.confirmation);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to load manifest.");
    } finally {
      setLoading(false);
    }
  }

  async function confirmManifest() {
    const activeTenantId = getActiveTenantId();
    if (!activeTenantId) {
      setStatus("Enter tenant ID before confirming a manifest.");
      return;
    }
    setLoading(true);
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant_id: activeTenantId }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Failed to confirm manifest.");
      }
      syncConfirmationState(data.confirmation);
      setStatus(`Manifest confirmed for ${data.tenant_id} at ${data.path}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to confirm manifest.");
    } finally {
      setLoading(false);
    }
  }

  async function implementCustomization(options?: ImplementOptions) {
    if (!confirmedTenantId) {
      setStatus("Confirm the manifest before running implementation.");
      return;
    }

    const isRepairPass = Boolean(options?.isRepairPass);
    const validatorIssues = Array.isArray(options?.validatorIssues)
      ? options.validatorIssues.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    const appTargets: string[] = ["frontend", "admin-frontend", "expert", "corporates"];

    setLoading(true);
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/api/tenant/implement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenant_id: confirmedTenantId,
          app_targets: appTargets,
          validator_issues: validatorIssues.length > 0 ? validatorIssues : undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Implementation failed.");
      }
      const allErrors = Array.isArray(data.errors)
        ? data.errors.filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
      if (allErrors.length > 0) {
        const validatorIssuesFromRun = allErrors.filter((issue: string) => issue.startsWith("Validator issue"));
        if (!isRepairPass && validatorIssuesFromRun.length > 0 && typeof window !== "undefined") {
          const shouldRetry = window.confirm(
            `Implementation found ${validatorIssuesFromRun.length} validator issue(s). Run one automatic repair pass now?`
          );
          if (shouldRetry) {
            await implementCustomization({ isRepairPass: true, validatorIssues: validatorIssuesFromRun });
            return;
          }
        }
        const statusPrefix = isRepairPass
          ? "Repair pass completed with remaining issues"
          : "Implementation completed with issues";
        setStatus(`${statusPrefix}: ${allErrors.join(" | ")}`);
        return;
      }
      if (isRepairPass) {
        setStatus(
          `Repair pass applied successfully. Targets: ${(data.app_targets || appTargets).join(", ")}.`
        );
      } else {
        setStatus(
          `Customization applied successfully. Targets: ${(data.app_targets || appTargets).join(", ")}.`
        );
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to implement customization.");
    } finally {
      setLoading(false);
    }
  }

  async function resetSession() {
    const activeTenantId = getActiveTenantId();
    if (!activeTenantId) {
      setStatus("Enter tenant ID before resetting a session.");
      return;
    }
    setLoading(true);
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant_id: activeTenantId }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Failed to reset session.");
      }
      setManifest(data.manifest);
      setMessages([]);
      syncConfirmationState(data.confirmation);
      setStatus("Session reset.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to reset session.");
    } finally {
      setLoading(false);
    }
  }

  async function resetTenantRepo() {
    const activeTenantId = getActiveTenantId();
    if (!activeTenantId) {
      setStatus("Enter tenant ID before resetting the tenant repo.");
      return;
    }

    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `This will delete and recreate the tenant repo for '${activeTenantId}'. Continue?`
      )
    ) {
      return;
    }

    setLoading(true);
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/api/admin/tenant/reset-repo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant_id: activeTenantId }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Failed to reset tenant repo.");
      }

      if (data.session_reset) {
        setMessages([]);
        if (data.manifest) {
          setManifest(data.manifest);
        }
        syncConfirmationState(data.confirmation);
      }

      const deletedExisting = data.deleted_existing_repo ? "yes" : "no";
      const recreated = data.recreated ? "yes" : "no";
      setStatus(
        `Tenant repo reset complete for ${data.tenant_id}. Session reset: ${data.session_reset ? "yes" : "no"}. Deleted existing repo: ${deletedExisting}. Recreated: ${recreated}. Inode: ${data.previous_inode ?? "n/a"} -> ${data.new_inode ?? "n/a"}. New repo path: ${data.repo_path}`
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to reset tenant repo.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        maxWidth: 960,
        margin: "0 auto",
        padding: 24,
        fontFamily: "sans-serif",
      }}
    >
      <h1>Tenant Builder Prototype</h1>
      <p>User Chat to Backend Agent to Manifest Builder</p>

      <section style={{ marginBottom: 16 }}>
        <label htmlFor="tenant-id-input" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
          Tenant ID
        </label>
        <input
          id="tenant-id-input"
          value={tenantId}
          onChange={(event) => setTenantId(event.target.value)}
          placeholder="e.g. cultureplace-us"
          style={{ width: "100%", maxWidth: 360, padding: 8 }}
        />
        <p style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
          Tenant ID is required before chat, confirm, asset upload, and implementation.
        </p>
      </section>

      <section
        style={{
          border: "1px solid #ccc",
          minHeight: 280,
          padding: 16,
          marginBottom: 16,
          overflowY: "auto",
        }}
      >
        {messages.length === 0 ? <p>No messages yet.</p> : null}
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`} style={{ marginBottom: 12 }}>
            <strong>{message.role === "user" ? "You" : "Agent"}: </strong>
            <span>{message.content}</span>
          </div>
        ))}
      </section>

      <form onSubmit={sendMessage} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Describe the tenant requirements"
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit" disabled={loading}>
          Send
        </button>
      </form>

      <section style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <button onClick={loadManifest} disabled={loading} type="button">
          Show Manifest
        </button>
        <button onClick={confirmManifest} disabled={loading} type="button">
          Confirm Manifest
        </button>
        {confirmedTenantId ? (
          <button onClick={() => void implementCustomization()} disabled={loading} type="button">
            Implement Customization
          </button>
        ) : null}
        <button onClick={resetTenantRepo} disabled={loading} type="button">
          Reset Tenant Repo
        </button>
        <button onClick={resetSession} disabled={loading} type="button">
          Reset Session
        </button>
      </section>

      {status ? <p>{status}</p> : null}

      <section style={{ marginBottom: 24 }}>
        <h2>Branding Assets</h2>
        <p style={{ fontSize: 13, color: "#555", marginBottom: 8 }}>
          Upload logo and favicon files. Accepted formats: PNG, JPG, SVG, ICO, WebP (max 5 MB).
          After uploading, confirm the manifest then run implementation to apply assets to the tenant repo.
        </p>
        <form
          onSubmit={uploadAsset}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
        >
          <select
            value={assetType}
            onChange={(e) => setAssetType(e.target.value as AssetType)}
            style={{ padding: 8 }}
            disabled={assetLoading}
          >
            {(Object.keys(ASSET_LABELS) as AssetType[]).map((type) => (
              <option key={type} value={type}>
                {ASSET_LABELS[type]}
              </option>
            ))}
          </select>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setAssetFile(e.target.files?.[0] ?? null)}
            disabled={assetLoading}
            style={{ padding: 4 }}
          />
          <button type="submit" disabled={assetLoading || !assetFile}>
            {assetLoading ? "Uploading…" : "Upload Asset"}
          </button>
        </form>
        {uploadedAssets.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <strong>Uploaded this session:</strong>
            <ul style={{ margin: "6px 0 0 16px", fontSize: 13 }}>
              {uploadedAssets.map((a) => (
                <li key={a.asset_type}>
                  <strong>{ASSET_LABELS[a.asset_type]}</strong>:{" "}
                  <a
                    href={`${API_BASE_URL}/api/tenant/assets/${
                      getActiveTenantId() ||
                      (manifest as Record<string, unknown> | null)?.["tenant_id"] as string ||
                      ""
                    }/${a.asset_type}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 12, color: "#0070f3" }}
                  >
                    Preview
                  </a>
                  <span style={{ marginLeft: 8, color: "#888", fontSize: 12 }}>{a.stored_path}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section>
        <h2>Manifest Preview</h2>
        <pre
          style={{
            border: "1px solid #ccc",
            padding: 16,
            background: "#f7f7f7",
            overflowX: "auto",
            whiteSpace: "pre-wrap",
          }}
        >
          {manifestText}
        </pre>
      </section>
    </main>
  );
}