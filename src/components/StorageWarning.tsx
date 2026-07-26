// A persistent banner when the browser store can no longer be written.
//
// This is the one storage failure the user must know about rather than merely
// have logged: on the phone it means this device's cache is full, and while the
// Mac still holds the real copy, silence here would let someone keep typing in
// the belief that everything is fine.

import { useEffect, useState } from "react";
import { onStorageFailure, type StorageFailure } from "../lib/storage";

export default function StorageWarning() {
  const [failure, setFailure] = useState<StorageFailure | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(
    () =>
      onStorageFailure((f) => {
        setFailure(f);
        setDismissed(false); // a new failure re-raises the banner
      }),
    []
  );

  if (!failure || dismissed) return null;

  return (
    <div className="storage-warning" role="alert">
      <span>{failure.message}</span>
      <button className="btn ghost" onClick={() => setDismissed(true)} aria-label="Dismiss warning">
        ×
      </button>
    </div>
  );
}
