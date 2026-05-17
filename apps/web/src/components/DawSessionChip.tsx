import type { DawKind, SessionProjectInfo } from "../lib/dawTypes";

const dawLabel = (daw: DawKind) => (daw === "ableton" ? "Ableton" : "FL Studio");

type Props = {
  project: SessionProjectInfo | null;
  onOpen?: () => void;
};

export const DawSessionChip = ({ project, onOpen }: Props) => {
  if (!project) {
    return null;
  }
  return (
    <button
      type="button"
      className={`daw-session-chip daw-session-chip--${project.daw}`}
      onClick={onOpen}
      title="Open DAW project panel"
    >
      <span className="daw-session-chip-icon" aria-hidden>
        {project.daw === "ableton" ? "AL" : "FL"}
      </span>
      <span>
        Project: <strong>{project.projectName}</strong> ({dawLabel(project.daw)})
      </span>
    </button>
  );
};
