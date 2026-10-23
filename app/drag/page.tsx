import type { Metadata } from "next";
import { DragApp } from "../../components/drag/DragApp";

export const metadata: Metadata = {
  title: "Drag Racing",
  description: "Head-to-head bracket drag racing in your browser: launch on the green, hit every shift. Reaction time decides it.",
};

export default function DragPage() {
  return <DragApp />;
}
