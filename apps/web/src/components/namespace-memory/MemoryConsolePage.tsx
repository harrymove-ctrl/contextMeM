import { useEffect, useState } from "react";
import { MemoryNamespacePicker } from "./MemoryNamespacePicker.js";
import { MemoryView } from "./MemoryView.js";

const STORAGE_KEY = "cm.memory.namespace";

export function MemoryConsolePage() {
  const [selectedNamespace, setSelectedNamespace] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? "",
  );

  useEffect(() => {
    if (selectedNamespace) localStorage.setItem(STORAGE_KEY, selectedNamespace);
    else localStorage.removeItem(STORAGE_KEY);
  }, [selectedNamespace]);

  if (!selectedNamespace) {
    return <MemoryNamespacePicker onSelect={setSelectedNamespace} />;
  }
  return <MemoryView namespace={selectedNamespace} onChange={() => setSelectedNamespace("")} />;
}
