import type { Participant } from "livekit-client";
import type { MixerChannelState, RoomSyncState } from "../lib/sessionState";

type Props = {
  participants: Participant[];
  localIdentity: string;
  roomState: RoomSyncState;
  isMaster: boolean;
  onChange: (state: RoomSyncState) => void;
};

const assignChannels = (participants: Participant[], localIdentity: string) => {
  const identities = [
    localIdentity,
    ...participants
      .map((participant) => participant.identity)
      .filter((identity) => identity && identity !== localIdentity)
  ].slice(0, 4);

  return identities.map((identity, index) => ({
    identity,
    channel: (index + 1) as 1 | 2 | 3 | 4
  }));
};

export const SessionMixerPanel = ({
  participants,
  localIdentity,
  roomState,
  isMaster,
  onChange
}: Props) => {
  const assignments = assignChannels(participants, localIdentity);

  const getChannel = (identity: string, channel: 1 | 2 | 3 | 4): MixerChannelState => {
    const existing = roomState.mixer.find(
      (entry) => entry.identity === identity && entry.channel === channel
    );
    return (
      existing ?? {
        identity,
        channel,
        gain: 1,
        pan: 0,
        mute: false
      }
    );
  };

  const updateChannel = (next: MixerChannelState) => {
    const others = roomState.mixer.filter(
      (entry) => !(entry.identity === next.identity && entry.channel === next.channel)
    );
    onChange({ ...roomState, mixer: [...others, next] });
  };

  const toggleParticipantLoop = (identity: string) => {
    onChange({
      ...roomState,
      participantLoops: {
        ...roomState.participantLoops,
        [identity]: !roomState.participantLoops[identity]
      }
    });
  };

  return (
    <div className="groove-panel mixer-panel">
      <div className="sync-panel-header">
        <div>
          <div className="section-title">4-channel mixer</div>
          <div className="help-text">Gain, pan, and mute per participant (synced to peers).</div>
        </div>
        {!isMaster ? <span className="status-pill">View only</span> : null}
      </div>

      <div className="mixer-grid">
        {assignments.map(({ identity, channel }) => {
          const mixer = getChannel(identity, channel);
          const name =
            participants.find((participant) => participant.identity === identity)?.name ??
            identity;
          const loopOn = Boolean(roomState.participantLoops[identity]);
          return (
            <div key={`${identity}-${channel}`} className="mixer-channel">
              <div className="mixer-channel-head">
                <strong>CH {channel}</strong>
                <span>{name}</span>
              </div>
              <label>
                Gain
                <input
                  type="range"
                  min={0}
                  max={150}
                  value={Math.round(mixer.gain * 100)}
                  disabled={!isMaster}
                  onChange={(event) =>
                    updateChannel({ ...mixer, gain: Number(event.target.value) / 100 })
                  }
                />
              </label>
              <label>
                Pan
                <input
                  type="range"
                  min={-100}
                  max={100}
                  value={Math.round(mixer.pan * 100)}
                  disabled={!isMaster}
                  onChange={(event) =>
                    updateChannel({ ...mixer, pan: Number(event.target.value) / 100 })
                  }
                />
              </label>
              <div className="recording-row">
                <button
                  type="button"
                  className={mixer.mute ? "toggle active" : "toggle"}
                  disabled={!isMaster}
                  onClick={() => updateChannel({ ...mixer, mute: !mixer.mute })}
                >
                  {mixer.mute ? "Muted" : "Mute"}
                </button>
                <button
                  type="button"
                  className={loopOn ? "toggle active" : "toggle"}
                  disabled={!isMaster}
                  onClick={() => toggleParticipantLoop(identity)}
                >
                  Loop {loopOn ? "On" : "Off"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="recording-row">
        <button
          type="button"
          className={roomState.sessionLoop ? "toggle active" : "toggle"}
          disabled={!isMaster}
          onClick={() => onChange({ ...roomState, sessionLoop: !roomState.sessionLoop })}
        >
          Session loop {roomState.sessionLoop ? "On" : "Off"}
        </button>
      </div>
    </div>
  );
};
