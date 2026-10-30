import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CruiseLoader } from "../../../components/cruise/CruiseLoader";
import { gaugeMaxKmh, getVehicle, vehicles } from "../../../lib/vehicles";

export const dynamicParams = false;

export function generateStaticParams() {
  return vehicles.map((v) => ({ vehicleId: v.id }));
}

export async function generateMetadata({ params }: PageProps<"/cruise/[vehicleId]">): Promise<Metadata> {
  const { vehicleId } = await params;
  const v = getVehicle(vehicleId);
  if (!v) return {};
  const title = `Cruise in the ${v.name}`;
  const description = `Take the ${v.name} down an endless road through hills, forest and mountains, from sunrise to the stars. In your browser.`;
  return {
    title,
    description,
    openGraph: { title, description, type: "website", images: [{ url: "/og.png", width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", images: ["/og.png"] },
  };
}

export default async function CruisePage({ params }: PageProps<"/cruise/[vehicleId]">) {
  const { vehicleId } = await params;
  const vehicle = getVehicle(vehicleId);
  if (!vehicle) notFound();
  const i = vehicles.indexOf(vehicle);
  const at = (k: number) => {
    const v = vehicles[(k + vehicles.length) % vehicles.length];
    return { id: v.id, name: v.name };
  };
  const garage = vehicles.map((v) => ({ id: v.id, name: v.name, make: v.ui.make, year: v.ui.year, layout: v.ui.layout, accent: v.ui.accent }));
  return <CruiseLoader vehicle={vehicle} prev={at(i - 1)} next={at(i + 1)} maxKmh={gaugeMaxKmh(vehicle)} garage={garage} />;
}
