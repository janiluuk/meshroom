export type MixerChannelState = {
  identity: string;
  channel: 1 | 2 | 3 | 4;
  gain: number;
  pan: number;
  mute: boolean;
};

export type RoomSyncState = {
  mixer: MixerChannelState[];
  participantLoops: Record<string, boolean>;
  sessionLoop: boolean;
};

export const defaultRoomSyncState = (): RoomSyncState => ({
  mixer: [],
  participantLoops: {},
  sessionLoop: false
});

export const clampGain = (value: number) => Math.min(Math.max(value, 0), 1.5);

export const clampPan = (value: number) => Math.min(Math.max(value, -1), 1);
