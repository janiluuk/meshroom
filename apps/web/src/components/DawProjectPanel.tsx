import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatOpenInDawHints,
  formatPluginChecklistMarkdown
} from "../lib/dawChecklist";
import type { DawKind, ProjectAnalysisManifest, SessionProjectInfo } from "../lib/dawTypes";

type DawRevision = {
  id: string;
  projectId: string;
  fileName: string;
  status: string;
  error?: string;
  createdAt: string;
};

type DawProject = {
  id: string;
  name: string;
  daw: DawKind;
  revisionCount?: number;
};

type RevisionDiff = {
  tracksAdded: string[];
  tracksRemoved: string[];
  pluginsAdded: string[];
  pluginsRemoved: string[];
  tempoChanged?: { from?: number; to?: number };
};

type Props = {
  apiBaseUrl: string;
  authToken: string;
  sessionId: string;
  isMaster: boolean;
  onSessionProjectChange?: (info: SessionProjectInfo | null) => void;
};

const fetchJson = async <T,>(url: string, token: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return (await response.json()) as T;
};

export const DawProjectPanel = ({
  apiBaseUrl,
  authToken,
  sessionId,
  isMaster,
  onSessionProjectChange
}: Props) => {
  const [tab, setTab] = useState<"tracks" | "plugins" | "timeline" | "warnings">("tracks");
  const [library, setLibrary] = useState<DawProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [revisions, setRevisions] = useState<DawRevision[]>([]);
  const [selectedRevisionId, setSelectedRevisionId] = useState("");
  const [analysis, setAnalysis] = useState<ProjectAnalysisManifest | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [boundRevisionId, setBoundRevisionId] = useState<string | null>(null);
  const [diff, setDiff] = useState<RevisionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDaw, setNewProjectDaw] = useState<DawKind>("ableton");

  const notifySessionProject = useCallback(
    (info: SessionProjectInfo | null) => {
      onSessionProjectChange?.(info);
    },
    [onSessionProjectChange]
  );

  const refreshLibrary = useCallback(async () => {
    const data = await fetchJson<{ projects: DawProject[] }>(`${apiBaseUrl}/projects`, authToken);
    setLibrary(data.projects);
  }, [apiBaseUrl, authToken]);

  const refreshSessionProject = useCallback(async () => {
    try {
      const data = await fetchJson<{
        revision: DawRevision;
        analysis: ProjectAnalysisManifest | null;
        downloadUrl?: string | null;
      }>(`${apiBaseUrl}/sessions/${sessionId}/project`, authToken);
      setBoundRevisionId(data.revision.id);
      setAnalysis(data.analysis);
      setDownloadUrl(data.downloadUrl ?? null);
      if (data.analysis) {
        setSelectedProjectId(data.revision.projectId);
        setSelectedRevisionId(data.revision.id);
        notifySessionProject({
          projectName: data.analysis.projectName,
          daw: data.analysis.daw,
          revisionId: data.revision.id,
          fileName: data.revision.fileName
        });
      } else {
        notifySessionProject(null);
      }
    } catch {
      setBoundRevisionId(null);
      setAnalysis(null);
      setDownloadUrl(null);
      notifySessionProject(null);
    }
  }, [apiBaseUrl, authToken, sessionId, notifySessionProject]);

  const refreshRevisions = useCallback(
    async (projectId: string) => {
      if (!projectId) {
        setRevisions([]);
        return;
      }
      const data = await fetchJson<{ revisions: DawRevision[] }>(
        `${apiBaseUrl}/projects/${projectId}/revisions`,
        authToken
      );
      setRevisions(data.revisions);
    },
    [apiBaseUrl, authToken]
  );

  const loadAnalysis = useCallback(
    async (projectId: string, revisionId: string, revisionList: DawRevision[]) => {
      const data = await fetchJson<{ analysis: ProjectAnalysisManifest; revision: DawRevision }>(
        `${apiBaseUrl}/projects/${projectId}/revisions/${revisionId}/analysis`,
        authToken
      );
      setAnalysis(data.analysis);
      if (revisionList.length >= 2) {
        const other = revisionList.find((revision) => revision.id !== revisionId);
        if (other && other.status === "ready") {
          try {
            const diffData = await fetchJson<{ diff: RevisionDiff }>(
              `${apiBaseUrl}/projects/${projectId}/revisions/${other.id}/diff/${revisionId}`,
              authToken
            );
            setDiff(diffData.diff);
          } catch {
            setDiff(null);
          }
        }
      }
    },
    [apiBaseUrl, authToken]
  );

  useEffect(() => {
    refreshLibrary().catch(() => undefined);
    refreshSessionProject().catch(() => undefined);
  }, [refreshLibrary, refreshSessionProject]);

  useEffect(() => {
    if (!isMaster) {
      const interval = window.setInterval(() => {
        refreshSessionProject().catch(() => undefined);
      }, 4000);
      return () => window.clearInterval(interval);
    }
    return undefined;
  }, [isMaster, refreshSessionProject]);

  useEffect(() => {
    if (selectedProjectId && isMaster) {
      refreshRevisions(selectedProjectId).catch(() => undefined);
    }
  }, [selectedProjectId, refreshRevisions, isMaster]);

  useEffect(() => {
    if (!selectedProjectId || !selectedRevisionId || !isMaster) {
      return;
    }
    const revision = revisions.find((entry) => entry.id === selectedRevisionId);
    if (revision?.status === "ready") {
      loadAnalysis(selectedProjectId, selectedRevisionId, revisions).catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load analysis")
      );
    } else if (revision?.status === "failed") {
      setError(revision.error ?? "Parse failed");
      setAnalysis(null);
    } else {
      setAnalysis(null);
    }
  }, [selectedProjectId, selectedRevisionId, revisions, loadAnalysis, isMaster]);

  const handleCreateProject = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await fetchJson<{ project: DawProject }>(`${apiBaseUrl}/projects`, authToken, {
        method: "POST",
        body: JSON.stringify({ name: newProjectName, daw: newProjectDaw })
      });
      setSelectedProjectId(data.project.id);
      await refreshLibrary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async (file: File) => {
    if (!selectedProjectId) {
      setError("Select or create a project first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(`${apiBaseUrl}/projects/${selectedProjectId}/revisions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
        body: form
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const data = (await response.json()) as { revision: DawRevision };
      setSelectedRevisionId(data.revision.id);
      const updated = await fetchJson<{ revisions: DawRevision[] }>(
        `${apiBaseUrl}/projects/${selectedProjectId}/revisions`,
        authToken
      );
      setRevisions(updated.revisions);
      const poll = async () => {
        const rev = await fetchJson<{ revision: DawRevision }>(
          `${apiBaseUrl}/projects/${selectedProjectId}/revisions/${data.revision.id}`,
          authToken
        );
        if (rev.revision.status === "ready") {
          await loadAnalysis(selectedProjectId, data.revision.id, updated.revisions);
          setBusy(false);
          return;
        }
        if (rev.revision.status === "failed") {
          setError(rev.revision.error ?? "Parse failed");
          setBusy(false);
          return;
        }
        window.setTimeout(poll, 800);
      };
      void poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setBusy(false);
    }
  };

  const handleBindSession = async () => {
    if (!selectedProjectId || !selectedRevisionId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await fetchJson(`${apiBaseUrl}/sessions/${sessionId}/project`, authToken, {
        method: "POST",
        body: JSON.stringify({
          projectId: selectedProjectId,
          revisionId: selectedRevisionId
        })
      });
      await refreshSessionProject();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bind failed");
    } finally {
      setBusy(false);
    }
  };

  const handleCopyChecklist = async () => {
    if (!analysis) {
      return;
    }
    const markdown = formatPluginChecklistMarkdown(analysis);
    try {
      await navigator.clipboard.writeText(markdown);
      setCopyStatus("Checklist copied to clipboard.");
    } catch {
      setCopyStatus("Could not copy — select and copy from the box below.");
    }
    window.setTimeout(() => setCopyStatus(null), 3000);
  };

  const openHints = useMemo(
    () => (analysis ? formatOpenInDawHints(analysis) : null),
    [analysis]
  );

  const maxBar = useMemo(() => {
    if (!analysis) {
      return 32;
    }
    return analysis.tracks.reduce((max, track) => {
      const clipMax = track.clips.reduce((inner, clip) => Math.max(inner, clip.endBar), 0);
      return Math.max(max, clipMax, analysis.lengthBars ?? 0);
    }, 16);
  }, [analysis]);

  return (
    <div className="groove-panel daw-project-panel" id="daw-project-panel">
      <div className="sync-panel-header">
        <div>
          <div className="section-title">DAW project</div>
          <div className="help-text">
            Upload Ableton (.als) or FL Studio (.flp) for tracks, plugins, and timeline.
          </div>
        </div>
        {boundRevisionId ? (
          <span className="status-pill active-pill">Bound to session</span>
        ) : (
          <span className="status-pill">Not bound</span>
        )}
      </div>

      {isMaster ? (
        <div className="form-grid">
          <div className="field">
            <label>New project</label>
            <div className="recording-row">
              <input
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
                placeholder="Project name"
              />
              <select
                value={newProjectDaw}
                onChange={(event) => setNewProjectDaw(event.target.value as DawKind)}
              >
                <option value="ableton">Ableton</option>
                <option value="flstudio">FL Studio</option>
              </select>
              <button type="button" onClick={() => handleCreateProject()} disabled={busy || !newProjectName.trim()}>
                Create
              </button>
            </div>
          </div>
          <div className="field">
            <label>Library</label>
            <select
              value={selectedProjectId}
              onChange={(event) => {
                setSelectedProjectId(event.target.value);
                setSelectedRevisionId("");
                setDiff(null);
              }}
            >
              <option value="">Select project…</option>
              {library.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} ({project.daw}) · {project.revisionCount ?? 0} rev
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Revision</label>
            <select
              value={selectedRevisionId}
              onChange={(event) => setSelectedRevisionId(event.target.value)}
              disabled={!revisions.length}
            >
              {revisions.map((revision) => (
                <option key={revision.id} value={revision.id}>
                  {revision.fileName} — {revision.status}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Upload</label>
            <div className="recording-row">
              <input
                type="file"
                accept=".als,.flp"
                disabled={!selectedProjectId || busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void handleUpload(file);
                  }
                }}
              />
              <button
                type="button"
                onClick={() => handleBindSession()}
                disabled={!selectedRevisionId || busy}
              >
                Set active for session
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {analysis ? (
        <>
          <div className="sync-readout">
            <div>
              <span>Project</span>
              <strong>{analysis.projectName}</strong>
            </div>
            <div>
              <span>DAW</span>
              <strong>{analysis.daw}</strong>
            </div>
            <div>
              <span>BPM</span>
              <strong>{analysis.tempo ?? "—"}</strong>
            </div>
            <div>
              <span>Tracks</span>
              <strong>{analysis.tracks.length}</strong>
            </div>
          </div>

          {diff ? (
            <div className="help-text">
              Diff vs previous: +{diff.tracksAdded.length} tracks, +{diff.pluginsAdded.length} plugins
              {diff.tempoChanged
                ? ` · tempo ${diff.tempoChanged.from ?? "?"} → ${diff.tempoChanged.to ?? "?"}`
                : ""}
            </div>
          ) : null}

          {openHints ? (
            <div className="daw-open-hints">
              <div className="section-title">Open in {openHints.dawLabel}</div>
              <ol>
                {openHints.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              {downloadUrl ? (
                <a className="daw-download-link" href={downloadUrl} download={analysis.sourceFile.name}>
                  Download {analysis.sourceFile.name}
                </a>
              ) : null}
              {openHints.sampleWarnings.length ? (
                <ul className="daw-track-list">
                  {openHints.sampleWarnings.map((warning, index) => (
                    <li key={`${warning.code}-${index}`}>
                      <strong>{warning.code}</strong>
                      <span>{warning.message}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div className="recording-row">
            {(["tracks", "plugins", "timeline", "warnings"] as const).map((key) => (
              <button
                key={key}
                type="button"
                className={tab === key ? "toggle active" : "toggle"}
                onClick={() => setTab(key)}
              >
                {key}
              </button>
            ))}
            {tab === "plugins" ? (
              <button type="button" className="toggle" onClick={() => handleCopyChecklist()}>
                Copy checklist
              </button>
            ) : null}
          </div>

          {copyStatus ? <div className="help-text">{copyStatus}</div> : null}

          {tab === "tracks" ? (
            <ul className="daw-track-list">
              {analysis.tracks.map((track) => (
                <li key={track.id} style={{ borderLeftColor: track.color ?? "var(--border)" }}>
                  <strong>{track.name}</strong>
                  <span>
                    {track.type} · {track.plugins.length} devices · {track.clips.length} clips
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {tab === "plugins" ? (
            <ul className="daw-track-list">
              {analysis.pluginsSummary.map((plugin) => (
                <li key={`${plugin.format}-${plugin.name}`}>
                  <strong>{plugin.name}</strong>
                  <span>
                    {plugin.format}
                    {plugin.vendor ? ` · ${plugin.vendor}` : ""} · tracks {plugin.usedOnTracks.join(", ")}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {tab === "timeline" ? (
            <div className="daw-timeline">
              {analysis.tracks.map((track) => (
                <div key={track.id} className="daw-timeline-row">
                  <div className="daw-timeline-label">{track.name}</div>
                  <div className="daw-timeline-lane">
                    {track.clips.map((clip) => (
                      <div
                        key={`${track.id}-${clip.name}-${clip.startBar}`}
                        className="daw-timeline-clip"
                        style={{
                          left: `${((clip.startBar - 1) / maxBar) * 100}%`,
                          width: `${((clip.endBar - clip.startBar) / maxBar) * 100}%`,
                          background: clip.color ?? track.color ?? "var(--accent)"
                        }}
                        title={clip.name}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {tab === "warnings" ? (
            <ul className="daw-track-list">
              {analysis.warnings.length ? (
                analysis.warnings.map((warning, index) => (
                  <li key={`${warning.code}-${index}`}>
                    <strong>{warning.code}</strong>
                    <span>{warning.message}</span>
                  </li>
                ))
              ) : (
                <li>No warnings.</li>
              )}
            </ul>
          ) : null}
        </>
      ) : (
        <div className="help-text">
          {isMaster
            ? "Create or select a project, upload a set file, then bind it to this session."
            : "Waiting for the session host to attach a DAW project."}
        </div>
      )}

      {error ? <div style={{ color: "var(--danger)" }}>{error}</div> : null}
    </div>
  );
};
