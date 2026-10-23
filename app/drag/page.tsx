import type { Metadata } from "next";
import { DragApp } from "../../components/drag/DragApp";

export const metadata: Metadata = {
  title: "Drag Racing",
  description: "Heads-up drag racing in classes of equal cars: launch on the green, hit every shift. Reaction time decides it.",
};

export default function DragPage() {
  return <DragApp />;
}
