// Word-count goal for the current document.
//
// Deliberately quiet: a thin progress line and a number. Writing tools that
// gamify hard (streaks, confetti, guilt) get uninstalled by the people who write
// the most, so this states progress and otherwise stays out of the way.

interface Props {
  words: number;
  /** 0 disables the goal entirely. */
  goal: number;
  onChangeGoal: (goal: number) => void;
}

const PRESETS = [0, 500, 1000, 1667, 2000];

export default function WordGoal({ words, goal, onChangeGoal }: Props) {
  const pct = goal > 0 ? Math.min(100, Math.round((words / goal) * 100)) : 0;
  const done = goal > 0 && words >= goal;

  return (
    <div className="wordgoal">
      <span className="wordgoal-count">
        {words.toLocaleString()} word{words === 1 ? "" : "s"}
      </span>

      {goal > 0 && (
        <>
          <span
            className="wordgoal-bar"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${pct}% of ${goal.toLocaleString()} word goal`}
          >
            <span
              className={done ? "wordgoal-fill done" : "wordgoal-fill"}
              style={{ width: `${pct}%` }}
            />
          </span>
          <span className="wordgoal-pct">
            {done ? "goal reached" : `${pct}% of ${goal.toLocaleString()}`}
          </span>
        </>
      )}

      <select
        className="wordgoal-select"
        aria-label="Word goal for this document"
        title="Word goal"
        value={PRESETS.includes(goal) ? goal : 0}
        onChange={(e) => onChangeGoal(Number(e.target.value))}
      >
        {PRESETS.map((p) => (
          <option key={p} value={p}>
            {p === 0 ? "No goal" : `${p.toLocaleString()} words`}
          </option>
        ))}
      </select>
    </div>
  );
}
