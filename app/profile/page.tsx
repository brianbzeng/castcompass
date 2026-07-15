import type { Metadata } from "next";
import sites from "../../public/data/sites.json";
import { ProfilePage } from "../components/ProfilePage";
import type { FishingSite } from "../types";

export const metadata: Metadata = {
  title: "Fishing profile",
  description: "Manage saved fishing locations, trip logs, and gear presets.",
};

export default function ProfileRoute() {
  return <ProfilePage sites={sites as FishingSite[]} />;
}
