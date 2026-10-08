import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SimulatorLoader } from "../../../components/SimulatorLoader";
import { gaugeMaxKmh, getVehicle, vehicles } from "../../../lib/vehicles";
import { assertVehicleFilesExist } from "../../../lib/vehicles/validate.node";

export const dynamicParams = false;

export function generateStaticParams() {
  assertVehicleFilesExist();
  return vehicles.map((v) => ({ vehicleId: v.id }));
}

export async function generateMetadata({ params }: PageProps<"/drive/[vehicleId]">): Promise<Metadata> {
  const { vehicleId } = await params;
  const v = getVehicle(vehicleId);
  if (!v) return {};
  const title = `Drive the ${v.name}`;
  const description = `${v.engineType}. ${v.description} Start it, rev it and shift gears in your browser.`;
  return {
    title,
    description,
    openGraph: { title, description, type: "website", images: [{ url: "/og.png", width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", images: ["/og.png"] },
  };
}

export default async function DrivePage({ params }: PageProps<"/drive/[vehicleId]">) {
  const { vehicleId } = await params;
  const vehicle = getVehicle(vehicleId);
  if (!vehicle) notFound();
  const i = vehicles.indexOf(vehicle);
  const at = (k: number) => {
    const v = vehicles[(k + vehicles.length) % vehicles.length];
    return { id: v.id, name: v.name };
  };
  return <SimulatorLoader vehicle={vehicle} prev={at(i - 1)} next={at(i + 1)} maxKmh={gaugeMaxKmh(vehicle)} />;
}
