import Head from "next/head";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type TrackManifest = {
  participantIdentity: string;
  participantName?: string;
  kind: "audio";
  url: string;
  startOffsetMs?: number;
};

type ParticipantManifest = {
  identity: string;
  name?: string;
};

type SessionManifest = {
  sessionId: string;
  room: string;
  startedAt: string;
  endedAt?: string;
  participants: ParticipantManifest[];
  tracks: TrackManifest[];
  masterMixUrl?: string;
};

type TrackState = {
  id: string;
  identity: string;
  displayName: string;
  kind: "audio" | "video" | "unknown";
  url: string;
  offsetSec: number;
  durationSec?: number;
  status: "loading" | "ready" | "error";
  error?: string;
  volume: number;
  muted: boolean;
  solo: boolean;
};

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const formatTime = (value: number | undefined) => {
  if (value === undefined || !Number.isFinite(value)) {
    return "--:--";
  }
  const total = Math.max(0, Math.floor(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const paddedSeconds = String(seconds).padStart(2, "0");
  if (hours > 0) {
    const paddedMinutes = String(minutes).padStart(2, "0");
    return `${hours}:${paddedMinutes}:${paddedSeconds}`;
  }
  return `${minutes}:${paddedSeconds}`;
};

const PlaybackPage = () => {
  const router = useRouter();
  const { id } = router.query;
  const [manifest, setManifest] = useState<SessionManifest | null>(null);
  const [tracks, setTracks] = useState<TrackState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [missingOffsets, setMissingOffsets] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const audioBuffersRef = useRef<Map<string, AudioBuffer>>(new Map());
  const gainNodesRef = useRef<Map<string, GainNode>>(new Map());
  const sourcesRef = useRef<Map<string, AudioBufferSourceNode>>(new Map());
  const playheadRef = useRef(0);
  const playStartRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const tracksRef = useRef<TrackState[]>([]);
  const durationRef = useRef(0);
  const isPlayingRef = useRef(false);
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const loadingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  const sessionDurationSec = useMemo(() => {
    let maxDuration = 0;
    for (const track of tracks) {
      if (track.durationSec !== undefined) {
        const end = track.offsetSec + track.durationSec;
        if (end > maxDuration) {
          maxDuration = end;
        }
      }
    }
    return maxDuration;
  }, [tracks]);

  const isLoadingTracks = useMemo(() => tracks.some((track) => track.status === "loading"), [tracks]);

  useEffect(() => {
    durationRef.current = sessionDurationSec;
  }, [sessionDurationSec]);

  useEffect(() => {
    return () => {
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
      }
      stopSources();
      for (const video of videoRefs.current.values()) {
        video.pause();
      }
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => undefined);
        audioContextRef.current = null;
      }
    };
  }, []);

  const ensureAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    return audioContextRef.current;
  };

  const stopSources = () => {
    for (const source of sourcesRef.current.values()) {
      try {
        source.stop();
      } catch (error) {
        // ignore
      }
    }
    sourcesRef.current.clear();
  };

  const getGainNode = (trackId: string) => {
    const existing = gainNodesRef.current.get(trackId);
    if (existing) {
      return existing;
    }
    const audioContext = ensureAudioContext();
    const gainNode = audioContext.createGain();
    gainNode.connect(audioContext.destination);
    gainNodesRef.current.set(trackId, gainNode);
    return gainNode;
  };

  const syncVideoPlayback = useCallback((masterTime: number, playing: boolean) => {
    const list = tracksRef.current;
    for (const track of list) {
      if (track.kind !== "video") {
        continue;
      }
      const video = videoRefs.current.get(track.id);
      if (!video) {
        continue;
      }
      const target = masterTime - track.offsetSec;
      if (target < 0) {
        video.pause();
        video.currentTime = 0;
        continue;
      }
      if (track.durationSec !== undefined && target >= track.durationSec) {
        video.pause();
        continue;
      }
      if (Math.abs(video.currentTime - target) > 0.15) {
        video.currentTime = target;
      }
      if (playing) {
        video.play().catch(() => undefined);
      } else {
        video.pause();
      }
    }
  }, []);

  const applyTrackGains = useCallback(() => {
    const audioContext = audioContextRef.current;
    const soloActive = tracksRef.current.some((track) => track.solo);
    for (const track of tracksRef.current) {
      const effective = soloActive ? track.solo && !track.muted : !track.muted;
      const volume = effective ? track.volume : 0;
      const gainNode = gainNodesRef.current.get(track.id);
      if (gainNode && audioContext) {
        gainNode.gain.setTargetAtTime(volume, audioContext.currentTime, 0.02);
      }
      if (track.kind === "video") {
        const video = videoRefs.current.get(track.id);
        if (video) {
          video.muted = volume === 0;
          video.volume = volume;
        }
      }
    }
  }, []);

  const schedulePlayback = useCallback(
    async (fromSeconds: number) => {
      const audioContext = ensureAudioContext();
      await audioContext.resume();
      stopSources();

      playStartRef.current = audioContext.currentTime - fromSeconds;

      for (const track of tracksRef.current) {
        if (track.kind !== "audio") {
          continue;
        }
        const buffer = audioBuffersRef.current.get(track.id);
        if (!buffer) {
          continue;
        }
        const trackOffset = track.offsetSec;
        const bufferOffset = Math.max(fromSeconds - trackOffset, 0);
        if (bufferOffset >= buffer.duration) {
          continue;
        }
        const delay = Math.max(trackOffset - fromSeconds, 0);
        const startAt = audioContext.currentTime + delay;
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        const gainNode = getGainNode(track.id);
        source.connect(gainNode);
        source.start(startAt, bufferOffset);
        sourcesRef.current.set(track.id, source);
      }

      applyTrackGains();
      syncVideoPlayback(fromSeconds, true);
    },
    [applyTrackGains, syncVideoPlayback]
  );

  const tick = useCallback(() => {
    if (!isPlayingRef.current) {
      return;
    }
    const audioContext = audioContextRef.current;
    const now = audioContext ? audioContext.currentTime : performance.now() / 1000;
    const current = now - playStartRef.current;
    playheadRef.current = current;
    setPlayheadSec(current);
    syncVideoPlayback(current, true);

    if (durationRef.current > 0 && current >= durationRef.current) {
      setIsPlaying(false);
      stopSources();
      syncVideoPlayback(durationRef.current, false);
      setPlayheadSec(durationRef.current);
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    rafRef.current = window.requestAnimationFrame(tick);
  }, [syncVideoPlayback]);

  const startPlayback = async () => {
    setIsPlaying(true);
    await schedulePlayback(playheadRef.current);
    if (rafRef.current) {
      window.cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = window.requestAnimationFrame(tick);
  };

  const pausePlayback = () => {
    setIsPlaying(false);
    const audioContext = audioContextRef.current;
    if (audioContext) {
      const current = audioContext.currentTime - playStartRef.current;
      playheadRef.current = current;
      setPlayheadSec(current);
    }
    stopSources();
    syncVideoPlayback(playheadRef.current, false);
    if (rafRef.current) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const stopPlayback = () => {
    pausePlayback();
    playheadRef.current = 0;
    setPlayheadSec(0);
    syncVideoPlayback(0, false);
  };

  const seekTo = async (value: number) => {
    playheadRef.current = value;
    setPlayheadSec(value);
    if (isPlayingRef.current) {
      await schedulePlayback(value);
    } else {
      syncVideoPlayback(value, false);
    }
  };

  const updateTrack = (trackId: string, updates: Partial<TrackState>) => {
    setTracks((prev) => prev.map((track) => (track.id === trackId ? { ...track, ...updates } : track)));
  };

  useEffect(() => {
    if (!id || typeof id !== "string") {
      return;
    }

    const loadManifest = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/sessions/${id}`);
        if (!response.ok) {
          throw new Error("Session not found");
        }
        const data = (await response.json()) as SessionManifest;
        setManifest(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load session");
      }
    };

    loadManifest();
  }, [id]);

  useEffect(() => {
    if (!manifest) {
      return;
    }

    const nameByIdentity = new Map(
      manifest.participants.map((participant) => [
        participant.identity,
        participant.name ?? participant.identity
      ])
    );

    const flattened: TrackState[] = [];
    let missingOffsetDetected = false;
    for (const track of manifest.tracks) {
      if (track.startOffsetMs === undefined) {
        missingOffsetDetected = true;
      }
      const offsetMs = track.startOffsetMs ?? 0;
      const offsetSec = Math.max(offsetMs / 1000, 0);
      const kind = track.kind === "audio" ? "audio" : "unknown";
      const identity = track.participantIdentity;
      flattened.push({
        id: `${identity}:${track.url}`,
        identity,
        displayName: track.participantName ?? nameByIdentity.get(identity) ?? identity,
        kind,
        url: track.url,
        offsetSec,
        durationSec: undefined,
        status: "loading",
        volume: 0.9,
        muted: false,
        solo: false
      });
    }

    if (manifest.masterMixUrl) {
      flattened.push({
        id: `master-mix:${manifest.masterMixUrl}`,
        identity: "master-mix",
        displayName: "Master Mix",
        kind: "audio",
        url: manifest.masterMixUrl,
        offsetSec: 0,
        durationSec: undefined,
        status: "loading",
        volume: 0.9,
        muted: false,
        solo: false
      });
    }

    setTracks(flattened);
    setMissingOffsets(missingOffsetDetected);
  }, [manifest]);

  useEffect(() => {
    if (!manifest) {
      return;
    }
    stopSources();
    if (rafRef.current) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    audioBuffersRef.current.clear();
    gainNodesRef.current.clear();
    loadingRef.current.clear();
    playheadRef.current = 0;
    setPlayheadSec(0);
    setIsPlaying(false);
  }, [manifest?.sessionId]);

  useEffect(() => {
    if (!tracks.length) {
      return;
    }

    let cancelled = false;
    const loadAudioTracks = async () => {
      for (const track of tracks) {
        if (track.kind !== "audio") {
          if (track.status === "loading") {
            updateTrack(track.id, { status: "ready" });
          }
          continue;
        }

        if (track.status !== "loading") {
          continue;
        }

        if (audioBuffersRef.current.has(track.id) || loadingRef.current.has(track.id)) {
          continue;
        }

        loadingRef.current.add(track.id);

        try {
          const response = await fetch(track.url);
          if (!response.ok) {
            throw new Error(`Failed to load ${track.url}`);
          }
          const arrayBuffer = await response.arrayBuffer();
          const audioContext = ensureAudioContext();
          const buffer = await audioContext.decodeAudioData(arrayBuffer);
          if (cancelled) {
            return;
          }
          audioBuffersRef.current.set(track.id, buffer);
          updateTrack(track.id, {
            status: "ready",
            durationSec: track.durationSec ?? buffer.duration
          });
        } catch (err) {
          updateTrack(track.id, {
            status: "error",
            error: err instanceof Error ? err.message : "Failed to decode audio"
          });
        } finally {
          loadingRef.current.delete(track.id);
        }
      }
    };

    loadAudioTracks();

    return () => {
      cancelled = true;
    };
  }, [tracks]);

  useEffect(() => {
    applyTrackGains();
  }, [tracks, applyTrackGains]);

  const soloActive = tracks.some((track) => track.solo);
  const downloadStems = () => {
    if (!manifest) {
      return;
    }
    const payload = {
      manifest,
      files: manifest.tracks.map((track) => track.url)
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `session-${manifest.sessionId}-stems.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 500);
  };

  return (
    <>
      <Head>
        <title>Playback | RemoteDJ</title>
      </Head>
      <main>
        <div className="header">
          <div className="logo">
            <span className="logo-badge">Playback</span>
            Session transport
          </div>
          <a className="playback-link" href="/">
            Back to live room
          </a>
        </div>

        {error ? <div style={{ color: "var(--danger)" }}>{error}</div> : null}
        {!manifest ? (
          <div>Loading session...</div>
        ) : (
          <div className="playback-shell">
            <div className="join-card">
              <div>
                <strong>Session:</strong> {manifest.sessionId}
              </div>
            <div>
              <strong>Room:</strong> {manifest.room}
            </div>
              <div>
                <strong>Started:</strong> {manifest.startedAt}
              </div>
              <div>
                <strong>Ended:</strong> {manifest.endedAt ?? "In progress"}
              </div>
              <div className="transport">
                <button onClick={isPlaying ? pausePlayback : startPlayback} disabled={isLoadingTracks}>
                  {isPlaying ? "Pause" : "Play"}
                </button>
                <button className="ghost" onClick={stopPlayback} disabled={isLoadingTracks}>
                  Stop
                </button>
                <button className="ghost" onClick={downloadStems} disabled={!manifest}>
                  Download stems
                </button>
                <div className="transport-time">
                  {formatTime(playheadSec)} / {formatTime(sessionDurationSec)}
                </div>
              </div>
              <input
                className="playhead"
                type="range"
                min={0}
                max={Math.max(sessionDurationSec, 0)}
                step={0.01}
                value={Math.min(playheadSec, sessionDurationSec || 0)}
                onChange={(event) => seekTo(Number(event.target.value))}
                disabled={isLoadingTracks}
              />
              {isLoadingTracks ? <div className="help-text">Decoding tracks...</div> : null}
              {missingOffsets ? (
                <div className="help-text">
                  Some tracks are missing offsets; playback starts them at t=0 for best-effort
                  alignment.
                </div>
              ) : null}
              {soloActive ? <div className="help-text">Solo active: non-solo tracks muted.</div> : null}
            </div>

            <div className="tracks-grid">
              {tracks.map((track) => {
                const statusLabel =
                  track.status === "loading"
                    ? "loading"
                    : track.status === "error"
                      ? "error"
                      : "ready";
                return (
                  <div className="track-card" key={track.id}>
                    <div className="track-header">
                      <div>
                      <div className="track-title">{track.displayName}</div>
                      <div className="track-sub">{track.kind}</div>
                    </div>
                    <div className="status-pill">{statusLabel}</div>
                  </div>
                  <div className="track-meta">
                    <span>Offset: {formatTime(track.offsetSec)}</span>
                    <span>Duration: {formatTime(track.durationSec)}</span>
                  </div>
                    {track.error ? <div className="notice warning">{track.error}</div> : null}
                    <div className="track-controls">
                      <button
                        className={track.solo ? "toggle active" : "toggle"}
                        onClick={() => updateTrack(track.id, { solo: !track.solo })}
                      >
                        Solo
                      </button>
                      <button
                        className={track.muted ? "toggle active" : "toggle"}
                        onClick={() => updateTrack(track.id, { muted: !track.muted })}
                      >
                        Mute
                      </button>
                      <div className="volume">
                        <label htmlFor={`volume-${track.id}`}>Volume</label>
                        <input
                          id={`volume-${track.id}`}
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={track.volume}
                          onChange={(event) => updateTrack(track.id, { volume: Number(event.target.value) })}
                        />
                      </div>
                    </div>
                    {track.kind === "video" ? (
                      <video
                        className="track-video"
                        ref={(node) => {
                          if (node) {
                            videoRefs.current.set(track.id, node);
                            if (node.src !== track.url) {
                              node.src = track.url;
                            }
                          } else {
                            videoRefs.current.delete(track.id);
                          }
                        }}
                        preload="auto"
                        playsInline
                        muted
                        onLoadedMetadata={(event) => {
                          const duration = event.currentTarget.duration;
                          if (Number.isFinite(duration)) {
                            updateTrack(track.id, {
                              durationSec: track.durationSec ?? duration,
                              status: track.status === "loading" ? "ready" : track.status
                            });
                          }
                        }}
                      />
                    ) : (
                      <div className="audio-placeholder">
                        <div className="wave">Audio track</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>
    </>
  );
};

export default PlaybackPage;
