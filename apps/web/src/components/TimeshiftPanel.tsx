import { useCallback, useEffect, useState } from "react";

type Snapshot = {
  id: string;
  message: string;
  createdAt: string;
  files: string[];
};

type Props = {
  apiBaseUrl: string;
  authToken: string;
  sessionId: string;
  isMaster: boolean;
};

const fetchJson = async <T,>(url: string, token: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as T;
};

export const TimeshiftPanel = ({ apiBaseUrl, authToken, sessionId, isMaster }: Props) => {
  const [enabled, setEnabled] = useState(true);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const data = await fetchJson<{ enabled: boolean; snapshots: Snapshot[] }>(
      `${apiBaseUrl}/sessions/${sessionId}/timeshift/snapshots`,
      authToken
    );
    setEnabled(data.enabled);
    setSnapshots(data.snapshots);
  }, [apiBaseUrl, authToken, sessionId]);

  useEffect(() => {
    refresh().catch(() => {
      setEnabled(false);
      setSnapshots([]);
    });
  }, [refresh]);

  const handleSnapshot = async () => {
    setBusy(true);
    setError(null);
    try {
      await fetchJson(`${apiBaseUrl}/sessions/${sessionId}/timeshift/snapshots`, authToken, {
        method: "POST",
        body: JSON.stringify({ message: "manual snapshot from session" })
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Snapshot failed");
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async (commitId: string) => {
    setBusy(true);
    setError(null);
    try {
      await fetchJson(`${apiBaseUrl}/sessions/${sessionId}/timeshift/restore`, authToken, {
        method: "POST",
        body: JSON.stringify({ commitId })
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed");
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await fetchJson<Record<string, unknown>>(
        `${apiBaseUrl}/sessions/${sessionId}/export`,
        authToken
      );
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `session-${sessionId}-stems.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="groove-panel timeshift-panel">
      <div className="sync-panel-header">
        <div>
          <div className="section-title">Timeshift</div>
          <div className="help-text">Git snapshots of session manifests and loop state.</div>
        </div>
        {isMaster ? (
          <div className="recording-row">
            <button type="button" onClick={() => handleSnapshot()} disabled={busy || !enabled}>
              Snapshot now
            </button>
            <button type="button" className="ghost" onClick={() => handleExport()} disabled={busy}>
              Export stems JSON
            </button>
          </div>
        ) : null}
      </div>

      {!enabled ? (
        <div className="help-text">Timeshift requires a git checkout (disabled in this environment).</div>
      ) : (
        <ul className="daw-track-list">
          {snapshots.length ? (
            snapshots.map((snapshot) => (
              <li key={snapshot.id}>
                <strong>{snapshot.message}</strong>
                <span>
                  {new Date(snapshot.createdAt).toLocaleString()} · {snapshot.id.slice(0, 7)}
                </span>
                {isMaster ? (
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => handleRestore(snapshot.id)}
                  >
                    Restore
                  </button>
                ) : null}
              </li>
            ))
          ) : (
            <li>No snapshots yet. Stop a recording or snapshot manually.</li>
          )}
        </ul>
      )}

      {error ? <div style={{ color: "var(--danger)" }}>{error}</div> : null}
    </div>
  );
};
